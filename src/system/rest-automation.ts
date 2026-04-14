import { Logger } from '../util/logger.js';
import { StringBuilder, Utility } from '../util/utility.js';
import { Composable } from '../models/composable.js';
import { Platform } from './platform.js';
import { PostOffice } from './post-office.js';
import {
  ObjectStreamIO,
  ObjectStreamWriter,
  ObjectStreamReader,
} from './object-stream.js';
import { EventEnvelope } from '../models/event-envelope.js';
import { AppException } from '../models/app-exception.js';
import { AsyncHttpRequest } from '../models/async-http-request.js';
import { RoutingEntry, AssignedRoute, HeaderInfo } from '../util/routing.js';
import { RateLimiter } from '../services/rate-limiter.js';
import { AppConfig, ConfigReader } from '../util/config-reader.js';
import { ContentTypeResolver } from '../util/content-type-resolver.js';
import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
// Keep Express types for the public setupMiddleWare API — the test imports
// NextFunction / Request / Response from 'express' directly.
import type { RequestHandler, Request, Response } from 'express';
import busboy from 'busboy';
import { Socket } from 'net';
import fs from 'fs';
import path from 'path';

const log = Logger.getInstance();
const util = new Utility();
const po = new PostOffice();
const resolver = ContentTypeResolver.getInstance();
const httpContext = {};
const CONTENT_TYPE = 'Content-Type';
const CONTENT_LENGTH = 'Content-Length';
const LOWERCASE_CONTENT_TYPE = 'content-type';
const APPLICATION_URL_ENCODED = 'application/x-www-form-urlencoded';
const APPLICATION_OCTET_STREAM = 'application/octet-stream';
const MULTIPART_FORM_DATA = 'multipart/form-data';
const APPLICATION_JSON = 'application/json';
const APPLICATION_XML = 'application/xml';
const TEXT_PREFIX = 'text/';
const TEXT_PLAIN = 'text/plain';
const TEXT_HTML = 'text/html';
const HTTPS = 'https';
const PROTOCOL = 'x-forwarded-proto';
const OPTIONS_METHOD = 'OPTIONS';
const HTML_START = '<html><body><pre>\n';
const HTML_END = '\n</pre></body></html>';
const REST_AUTOMATION_HOUSEKEEPER = 'rest.automation.housekeeper';
const ASYNC_HTTP_RESPONSE = 'async.http.response';
const STREAM_CONTENT = 'x-stream-id';
const DEFAULT_SERVER_PORT = 8086;

let loaded = false;
let server: Server = null;
let running = false;
let self: RestEngine;

// ---------------------------------------------------------------------------
// Express-compatible adapter types
//
// All business logic in this file was written against Express's req/res API.
// Rather than rewriting every method, we define thin interfaces that mirror
// the subset of the Express API actually used here and produce adapters from
// a Node.js IncomingMessage + ServerResponse pair.
// ---------------------------------------------------------------------------

type HttpBody = string | number | object | boolean | Buffer | Uint8Array;

interface AdaptedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string>;
  cookies: Record<string, string>;
  body: HttpBody;
  socket: { remoteAddress?: string };
  header(name: string): string | undefined;
  pipe(destination: unknown): void;
  // raw node stream for busboy
  _nodeReq: IncomingMessage;
}

interface AdaptedResponse {
  statusCode: number;
  status(code: number): AdaptedResponse;
  setHeader(key: string, value: string | number | readonly string[]): void;
  write(chunk: Buffer | string): void;
  end(): void;
  json(data: unknown): void;
  // raw node stream
  _nodeRes: ServerResponse;
}

function parseQueryString(rawQuery: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!rawQuery) return result;
  // Use URLSearchParams so that encoded characters are decoded correctly
  const params = new URLSearchParams(rawQuery);
  for (const [k, v] of params.entries()) {
    result[k] = v;
  }
  return result;
}

function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.substring(0, idx).trim();
      const v = part.substring(idx + 1).trim();
      result[k] = v;
    }
  }
  return result;
}

/**
 * Determine the MIME type for a file extension (minimal set matching Express/serve-static).
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? APPLICATION_OCTET_STREAM;
}

/**
 * Attempt to serve a static file.  Returns true if served, false if not found.
 * Mirrors Express's static middleware: directory requests serve index.html.
 */
async function serveStaticFile(
  htmlFolder: string,
  urlPath: string,
  res: ServerResponse,
): Promise<boolean> {
  // Sanitize path — strip leading slash and resolve against htmlFolder
  const safe = urlPath.replace(/\.\.\//g, '').replace(/\.\.\\/g, '');
  let candidate = path.join(htmlFolder, safe);

  try {
    const stat = await fs.promises.stat(candidate);
    if (stat.isDirectory()) {
      candidate = path.join(candidate, 'index.html');
      await fs.promises.stat(candidate); // throws if missing
    }
  } catch {
    return false;
  }

  const mimeType = getMimeType(candidate);
  const data = await fs.promises.readFile(candidate);
  res.statusCode = 200;
  res.setHeader(CONTENT_TYPE, mimeType);
  res.setHeader(CONTENT_LENGTH, data.length);
  res.end(data);
  return true;
}

/**
 * Read the full body from a Node.js IncomingMessage and parse it according
 * to the Content-Type header.  Returns the parsed body (string, object, or Buffer).
 */
async function parseBody(nodeReq: IncomingMessage): Promise<HttpBody> {
  const contentType = (nodeReq.headers['content-type'] as string) ?? '';
  const method = nodeReq.method?.toUpperCase() ?? '';

  // Only parse body for methods that carry one
  if (!['POST', 'PUT', 'PATCH'].includes(method)) {
    return undefined;
  }

  // Skip multipart — busboy handles it directly off the raw stream
  if (contentType.startsWith(MULTIPART_FORM_DATA)) {
    return undefined;
  }

  const MAX_BODY_SIZE = 2 * 1024 * 1024; // 2 MB
  const chunks: Buffer[] = [];
  let totalSize = 0;
  await new Promise<void>((resolve, reject) => {
    nodeReq.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        nodeReq.destroy();
        reject(new Error('Request body exceeds 2 MB limit'));
        return;
      }
      chunks.push(chunk);
    });
    nodeReq.on('end', resolve);
    nodeReq.on('error', reject);
  });
  const raw = Buffer.concat(chunks);

  if (contentType.startsWith(APPLICATION_URL_ENCODED)) {
    const params = new URLSearchParams(raw.toString());
    const result: Record<string, string> = {};
    for (const [k, v] of params.entries()) {
      result[k] = v;
    }
    return result;
  }

  if (contentType.startsWith(APPLICATION_JSON)) {
    try {
      return JSON.parse(raw.toString());
    } catch {
      return raw.toString();
    }
  }

  if (
    contentType.startsWith(APPLICATION_XML) ||
    contentType.startsWith(TEXT_PREFIX)
  ) {
    return raw.toString();
  }

  // Everything else (including application/octet-stream) → Buffer
  return raw;
}

/**
 * Wrap a Node.js IncomingMessage + ServerResponse into Express-compatible
 * adapters so all business logic below can remain unchanged.
 */
async function adaptNodeRequest(
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
): Promise<{ req: AdaptedRequest; res: AdaptedResponse }> {
  const parsedUrl = new URL(
    nodeReq.url ?? '/',
    `http://${nodeReq.headers.host ?? 'localhost'}`,
  );

  const query = parseQueryString(parsedUrl.search.substring(1));
  const cookies = parseCookies(nodeReq.headers.cookie as string | undefined);

  // Only consume the body once — multipart is intentionally skipped
  const body = await parseBody(nodeReq);

  // Normalise headers to a simple string record (first value wins for arrays)
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    headers[k.toLowerCase()] = v;
  }

  const req: AdaptedRequest = {
    method: nodeReq.method?.toUpperCase() ?? 'GET',
    path: parsedUrl.pathname,
    headers,
    query,
    cookies,
    body,
    socket: { remoteAddress: nodeReq.socket?.remoteAddress },
    header(name: string): string | undefined {
      const val = headers[name.toLowerCase()];
      return Array.isArray(val) ? val[0] : val;
    },
    pipe(destination: unknown) {
      // For busboy — pipe the raw node stream
      nodeReq.pipe(destination as NodeJS.WritableStream);
    },
    _nodeReq: nodeReq,
  };

  const setHeaders: Record<string, string | number | readonly string[]> = {};
  let statusCode = 200;
  let ended = false;

  const res: AdaptedResponse = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
      nodeRes.statusCode = v;
    },
    status(code: number) {
      statusCode = code;
      nodeRes.statusCode = code;
      return res;
    },
    setHeader(key: string, value: string | number | readonly string[]) {
      // Strip \r\n to prevent header injection
      const safeKey = String(key).replace(/[\r\n]/g, '');
      const safeValue =
        typeof value === 'string' ? value.replace(/[\r\n]/g, '') : value;
      setHeaders[safeKey] = safeValue;
      nodeRes.setHeader(safeKey, safeValue as string | number | string[]);
    },
    write(chunk: Buffer | string) {
      nodeRes.write(chunk);
    },
    end() {
      if (!ended) {
        ended = true;
        nodeRes.end();
      }
    },
    json(data: unknown) {
      const body = JSON.stringify(data);
      nodeRes.setHeader(CONTENT_TYPE, APPLICATION_JSON);
      nodeRes.setHeader(CONTENT_LENGTH, Buffer.byteLength(body));
      nodeRes.statusCode = statusCode;
      nodeRes.end(body);
      ended = true;
    },
    _nodeRes: nodeRes,
  };

  return { req, res };
}

// ---------------------------------------------------------------------------
// Helper functions (unchanged from original — still use AdaptedRequest/Response
// which implement the same interface subset Express used)
// ---------------------------------------------------------------------------

function keepSomeHeaders(headerInfo: HeaderInfo, headers: object): object {
  const result = {};
  for (const h in headers) {
    if (includesLabel(headerInfo.keepHeaders, h)) {
      result[h] = headers[h];
    }
  }
  return result;
}

function dropSomeHeaders(headerInfo: HeaderInfo, headers: object) {
  const result = {};
  for (const h in headers) {
    if (!includesLabel(headerInfo.dropHeaders, h)) {
      result[h] = headers[h];
    }
  }
  return result;
}

function includesLabel(headerLabels: Array<string>, h: string): boolean {
  for (const key of headerLabels) {
    if (util.equalsIgnoreCase(key, h)) {
      return true;
    }
  }
  return false;
}

async function copyToSecondaryTarget(p: RelayParameters) {
  for (let i = 1; i < p.route.info.services.length; i++) {
    const target = p.route.info.services[i];
    const secondary = new EventEnvelope()
      .setTo(target)
      .setFrom('http.request')
      .setBody(p.httpReq.toMap());
    if (p.traceId) {
      secondary.setTraceId(p.traceId);
      secondary.setTracePath(p.tracePath);
    }
    try {
      await po.send(secondary);
    } catch (e) {
      log.warn(`Unable to copy event to ${target} - ${e.message}`);
    }
  }
}

function setupResponseHeaders(
  route: AssignedRoute,
  router: RoutingEntry,
  traceHeaderLabel: string,
  serviceResponse: EventEnvelope,
  md: ResponseMetadata,
  httpHead: boolean,
) {
  for (const h in serviceResponse.getHeaders()) {
    const key = h.toLowerCase();
    const value = serviceResponse.getHeader(h);
    if (
      key == STREAM_CONTENT &&
      value.startsWith('stream.') &&
      value.endsWith('.in')
    ) {
      md.streamId = value;
    } else if (key == 'timeout') {
      md.streamTimeout = value;
    } else if (key == LOWERCASE_CONTENT_TYPE) {
      if (!httpHead) {
        md.resContentType = value.toLowerCase();
        md.resHeaders[CONTENT_TYPE] = md.resContentType;
      }
    } else {
      md.resHeaders[key] = value;
    }
  }
  const traceId = serviceResponse.getTraceId();
  if (traceId && traceHeaderLabel) {
    md.resHeaders[traceHeaderLabel] = traceId;
  }
  if (route.info.responseTransformId) {
    md.resHeaders = self.filterHeaders(
      router.getResponseHeaderInfo(route.info.responseTransformId),
      md.resHeaders,
    );
  }
}

function setupResponseContentType(req: AdaptedRequest, md: ResponseMetadata) {
  if (md.resContentType == null) {
    const accept = req.header('accept');
    if (accept) {
      if (accept.includes(TEXT_HTML)) {
        md.resContentType = TEXT_HTML;
        md.resHeaders[CONTENT_TYPE] = TEXT_HTML;
      } else if (accept.includes(APPLICATION_JSON) || accept.includes('*/*')) {
        md.resContentType = APPLICATION_JSON;
        md.resHeaders[CONTENT_TYPE] = APPLICATION_JSON;
      } else if (accept.includes(APPLICATION_XML)) {
        md.resContentType = APPLICATION_XML;
        md.resHeaders[CONTENT_TYPE] = APPLICATION_XML;
      } else if (accept.includes(APPLICATION_OCTET_STREAM)) {
        md.resContentType = APPLICATION_OCTET_STREAM;
        md.resHeaders[CONTENT_TYPE] = APPLICATION_OCTET_STREAM;
      } else {
        md.resContentType = TEXT_PLAIN;
        md.resHeaders[CONTENT_TYPE] = TEXT_PLAIN;
      }
    } else {
      md.resContentType = '?';
    }
  }
}

function setupResponseCookies(res: AdaptedResponse, md: ResponseMetadata) {
  for (const h in md.resHeaders) {
    if (h == 'set-cookie') {
      const cookieList = String(md.resHeaders[h])
        .split('|')
        .filter((v) => v.length > 0);
      for (const c of cookieList) {
        res.setHeader(self.getHeaderCase(h), c);
      }
    } else {
      res.setHeader(self.getHeaderCase(h), md.resHeaders[h]);
    }
  }
}

function writeHttpPayload(
  res: AdaptedResponse,
  resBody: unknown,
  serviceResponse: EventEnvelope,
  md: ResponseMetadata,
) {
  let b: Buffer = null;
  if (resBody instanceof Buffer) {
    b = resBody;
  } else if (resBody instanceof Object) {
    if (TEXT_HTML == md.resContentType) {
      b = Buffer.from(HTML_START + JSON.stringify(resBody, null, 2) + HTML_END);
    } else {
      b = Buffer.from(JSON.stringify(resBody, null, 2));
    }
  } else {
    b = Buffer.from(String(resBody));
  }
  res.setHeader(CONTENT_LENGTH, b.length);
  res.statusCode = serviceResponse.getStatus();
  res.write(b);
}

async function writeHttpStream(
  res: AdaptedResponse,
  route: AssignedRoute,
  serviceResponse: EventEnvelope,
  md: ResponseMetadata,
) {
  res.statusCode = serviceResponse.getStatus();
  if (md.streamId) {
    const timeout = self.getReadTimeout(
      md.streamTimeout,
      route.info.timeoutSeconds * 1000,
    );
    let done = false;
    const stream = new ObjectStreamReader(md.streamId, timeout);
    while (!done) {
      try {
        const block = await stream.read();
        if (block) {
          writeHttpData(block, res);
        } else {
          done = true;
        }
      } catch (e) {
        const status = e instanceof AppException ? e.getStatus() : 500;
        log.error(`Exception - rc=${status}, message=${e.message}`);
        done = true;
      }
    }
  }
}

function writeHttpData(block: unknown, res: AdaptedResponse) {
  if (block instanceof Buffer) {
    res.write(block);
  } else if (typeof block == 'string') {
    const b = Buffer.from(block);
    res.write(b);
  }
}

function ready(port: number) {
  const now = new Date();
  const diff = now.getTime() - Platform.getInstance().getStartTime().getTime();
  log.info(`Modules loaded in ${diff} ms`);
  log.info(`Reactive HTTP server running on port ${port}`);
  loaded = true;
}

class RelayParameters {
  authService: string;
  traceId: string;
  tracePath: string;
  traceHeaderLabel: string;
  httpReq: AsyncHttpRequest;
  req: AdaptedRequest;
  res: AdaptedResponse;
  route: AssignedRoute;
  router: RoutingEntry;
}

class ResponseMetadata {
  resContentType: string = null;
  resHeaders = {};
  streamId: string = null;
  streamTimeout: string = null;
}

export class RestAutomation {
  private static singleton: RestAutomation;

  /**
   * Enable REST automation
   */
  private constructor() {
    self ??= new RestEngine();
  }

  static getInstance(): RestAutomation {
    RestAutomation.singleton ??= new RestAutomation();
    return RestAutomation.singleton;
  }

  /**
   * Start the REST automation engine
   *
   * If "rest.automation.yaml" is defined in application.yml, REST automation will render the
   * rest.yaml file to accept the configured REST endpoints.
   * Otherwise, it will skip REST automation and provide basic actuator endpoints such as /info and /health
   */
  async start() {
    const platform = Platform.getInstance();
    await platform.getReady();
    await self.startHttpServer();
  }

  /**
   * Stop the REST automation engine
   *
   * @returns true when the stop command is executed.
   */
  async stop() {
    return await self.close();
  }

  /**
   * Wait for the REST automation system to be ready
   *
   * @returns true
   */
  async getReady() {
    // check if essential services are loaded
    const t1 = new Date().getTime();
    while (!loaded) {
      await util.sleep(1);
      // REST automation system should be ready very quickly.
      // If there is something that blocks it from starting up,
      // this would print alert every two seconds.
      const now = new Date().getTime();
      if (now - t1 >= 2000) {
        log.warn('Waiting for REST automation system to get ready');
        return false;
      }
    }
    return true;
  }

  /**
   * Optional: Setup additional Express-compatible middleware
   *
   * IMPORTANT: This API is provided for backward compatibility with existing code
   * that uses Express plugins. In a composable application, you can achieve the same
   * functionality by declaring your user function as an "interceptor".
   *
   * User defined middleware has input arguments (req: Request, res: Response, next: NextFunction).
   * It must call the "next()" method at the end of processing to pass the request and response
   * objects to the rest-automation engine for further processing.
   *
   * It should not touch the request body for multipart file upload because the rest-automation
   * engine will take care of it.
   *
   * If you must add middleware, call this method before you execute the "start" method in
   * rest-automation. Please refer to the BeforeAll section in po.test.ts file as a worked
   * example.
   *
   * @param handler implements RequestHandler
   */
  setupMiddleWare(handler: RequestHandler) {
    self.setupMiddleWare(handler);
  }
}

class HouseKeeper implements Composable {
  initialize(): Composable {
    return this;
  }

  async handleEvent(evt: EventEnvelope) {
    if ('close' == evt.getHeader('type')) {
      if (self) {
        await self.close();
      }
    }
    return null;
  }
}

class AsyncHttpResponse implements Composable {
  initialize(): Composable {
    return this;
  }

  async handleEvent(evt: EventEnvelope) {
    // creating a clean copy of the event, thus preventing metadata to propagate as HTTP response headers
    const serviceResponse = new EventEnvelope(evt);
    const cid = serviceResponse.getCorrelationId();
    const context = cid ? httpContext[cid] : null;
    if (context) {
      const req = context['req'] as AdaptedRequest;
      const res = context['res'] as AdaptedResponse;
      const httpReq = context['http'] as AsyncHttpRequest;
      const route = context['route'] as AssignedRoute;
      const router = context['router'] as RoutingEntry;
      const traceHeaderLabel = context['label'] as string;
      const watcher = context['watcher'] as NodeJS.Timeout;
      // immediate clear context after retrieval
      clearTimeout(watcher);
      delete context[cid];
      // handle response
      const httpHead = 'HEAD' == httpReq.getMethod();
      let resBody = serviceResponse.getBody();
      const md = new ResponseMetadata();
      // follow this sequence - headers, content-type and cookies
      setupResponseHeaders(
        route,
        router,
        traceHeaderLabel,
        serviceResponse,
        md,
        httpHead,
      );
      setupResponseContentType(req, md);
      setupResponseCookies(res, md);
      if (resBody) {
        if (
          typeof resBody == 'string' &&
          serviceResponse.getStatus() >= 400 &&
          md.resContentType &&
          md.resContentType.includes('json') &&
          !resBody.startsWith('{')
        ) {
          resBody = {
            type: 'error',
            status: serviceResponse.getStatus(),
            message: resBody,
          };
        }
        writeHttpPayload(res, resBody, serviceResponse, md);
      } else {
        await writeHttpStream(res, route, serviceResponse, md);
      }
      res.end();
    } else {
      log.error(`Async HTTP Context ${cid} expired`);
    }
    return null;
  }
}

class RestEngine {
  private readonly plugins = new Array<RequestHandler>();
  private readonly traceIdLabels: Array<string>;
  private readonly customContentTypes = new Map<string, string>();
  private readonly connections = new Map<number, Socket>();
  private htmlFolder: string;
  private loaded = false;

  constructor() {
    if (this.traceIdLabels === undefined) {
      const config = AppConfig.getInstance();
      this.traceIdLabels = config
        .getProperty('trace.http.header', 'x-trace-id')
        .split(',')
        .filter((v) => v.length > 0)
        .map((v) => v.toLowerCase());
      if (!this.traceIdLabels.includes('x-trace-id')) {
        this.traceIdLabels.push('x-trace-id');
      }
    }
  }

  async startHttpServer() {
    if (!this.loaded) {
      this.loaded = true;
      let restEnabled = false;
      const platform = Platform.getInstance();
      await platform.getReady();
      // register async.http.response and rest.automation.manager
      platform.register(ASYNC_HTTP_RESPONSE, new AsyncHttpResponse(), 200);
      platform.register(REST_AUTOMATION_HOUSEKEEPER, new HouseKeeper());
      const config = AppConfig.getInstance();
      const router = new RoutingEntry();
      // initialize router and load configuration
      const restYamlPath = config.getProperty(
        'yaml.rest.automation',
        'classpath:/rest.yaml',
      );
      if (restYamlPath) {
        const restYaml = util.loadYamlFile(
          config.resolveResourceFilePath(restYamlPath),
        );
        try {
          const restConfig = new ConfigReader(restYaml.getMap());
          router.load(restConfig);
          restEnabled = true;
        } catch (e) {
          log.error(`Unable to initialize REST endpoints - ${e.message}`);
        }
      }
      const staticFolder = config.getProperty('static.html.folder');
      if (staticFolder) {
        this.htmlFolder = config.resolveResourceFilePath(staticFolder);
        log.info(`Static HTML folder: ${this.htmlFolder}`);
      }
      this.setupCustomContentTypes(config);
      if (this.customContentTypes.size > 0) {
        log.info(`Loaded ${this.customContentTypes.size} custom content types`);
      }
      let port = util.str2int(
        config.getProperty('server.port', String(DEFAULT_SERVER_PORT)),
      );
      if (port < 80) {
        log.error(
          `Port ${port} is invalid. Reset to default port ${DEFAULT_SERVER_PORT}`,
        );
        port = DEFAULT_SERVER_PORT;
      }

      const htmlFolder = this.htmlFolder;
      const plugins = this.plugins;

      // Pure Node.js HTTP server — no Express, no Hono app layer.
      // All request handling flows through our own adapter + RoutingEntry logic.
      server = createServer(
        async (nodeReq: IncomingMessage, nodeRes: ServerResponse) => {
          try {
            // Run Express-style plugins first (they call next() to continue)
            if (plugins.length > 0) {
              await runPlugins(plugins, nodeReq, nodeRes);
            }

            // Build the adapters (consumes body for non-multipart requests)
            const { req, res } = await adaptNodeRequest(nodeReq, nodeRes);

            // Serve static files before hitting the REST router
            if (htmlFolder) {
              const served = await serveStaticFile(
                htmlFolder,
                req.path,
                nodeRes,
              );
              if (served) return;
            }

            await self.setupRestHandler(req, res, router, restEnabled);
          } catch (e) {
            // Last-resort error handler — build a minimal response if nodeRes is still writable
            if (!nodeRes.headersSent) {
              const rc = e instanceof AppException ? e.getStatus() : 500;
              const body = JSON.stringify({
                type: 'error',
                status: rc,
                message: e.message,
              });
              nodeRes.statusCode = rc;
              nodeRes.setHeader(CONTENT_TYPE, APPLICATION_JSON);
              nodeRes.setHeader(CONTENT_LENGTH, Buffer.byteLength(body));
              nodeRes.end(body);
            }
          }
        },
      );

      server.listen(port, '0.0.0.0', () => {
        running = true;
        setImmediate(() => {
          ready(port);
        });
      });

      // set server side socket timeout
      server.setTimeout(60000);
      server.on('error', (e) => {
        if ('code' in e && e['code'] == 'EADDRINUSE') {
          log.error(
            `\n` +
              `  ┌─────────────────────────────────────────────────────┐\n` +
              `  │  PORT ${port} IS ALREADY IN USE                      │\n` +
              `  │                                                     │\n` +
              `  │  Another process is using this port.                │\n` +
              `  │  Fix: kill the other process or change server.port  │\n` +
              `  │  in application.yml                                 │\n` +
              `  │                                                     │\n` +
              `  │  Find it:  lsof -i :${port}                          │\n` +
              `  │  Kill it:  kill $(lsof -t -i :${port})               │\n` +
              `  └─────────────────────────────────────────────────────┘`,
          );
          platform.stop();
        } else {
          log.error(`Network exception - ${e.message}`);
        }
      });
      let seq = 0;
      server.on('connection', (socket) => {
        const session = ++seq;
        log.debug(`Session ${session} connected`);
        this.connections.set(session, socket);
        socket.on('close', () => {
          this.connections.delete(session);
          log.debug(`Session ${session} closed`);
        });
      });
    }
  }

  private setupCustomContentTypes(config: ConfigReader) {
    const ctypes = config.getProperty('yaml.custom.content.types');
    if (ctypes) {
      const cFilePath = config.resolveResourceFilePath(ctypes);
      const cConfig = util.loadYamlFile(cFilePath);
      if (cConfig.exists('custom.content.types')) {
        const cSettings = cConfig.getElement('custom.content.types');
        if (cSettings instanceof Object && Array.isArray(cSettings)) {
          for (const entry of cSettings) {
            this.loadCustomContentTypes(entry);
          }
        }
      }
    }
    // load custom content types in application config if any
    const ct = config.get('custom.content.types');
    if (ct instanceof Object && Array.isArray(ct)) {
      for (const entry of ct) {
        this.loadCustomContentTypes(entry);
      }
    }
  }

  private loadCustomContentTypes(entry: string) {
    const sep = entry.indexOf('->');
    if (sep != -1) {
      const k = entry.substring(0, sep).trim();
      const v = entry.substring(sep + 2).trim();
      if (k && v) {
        this.customContentTypes.set(k, v.toLowerCase());
      }
    }
  }

  private async setupRestHandler(
    req: AdaptedRequest,
    res: AdaptedResponse,
    router: RoutingEntry,
    restEnabled: boolean,
  ) {
    const method = req.method;
    let uriPath: string;
    try {
      // Avoid "path traversal" attack by filtering "../" from URI
      uriPath = util.getDecodedUri(req.path);
    } catch (e) {
      this.rejectRequest(res, 400, e.message);
      return;
    }
    let found = false;
    if (restEnabled) {
      const assigned = router.getRouteInfo(method, uriPath);
      if (assigned) {
        if (assigned.info) {
          await this.processRestRequest(uriPath, req, res, assigned, router);
        } else {
          this.rejectRequest(res, 405, 'Method not allowed');
        }
        found = true;
      }
    }
    // send HTTP-404 when page is not found
    if (!found) {
      this.rejectRequest(res, 404, 'Resource not found');
    }
  }

  private async processRestRequest(
    uriPath: string,
    req: AdaptedRequest,
    res: AdaptedResponse,
    assigned: AssignedRoute,
    router: RoutingEntry,
  ) {
    try {
      await this.processRequest(uriPath, req, res, assigned, router);
    } catch (e) {
      const rc = e instanceof AppException ? e.getStatus() : 500;
      this.rejectRequest(res, rc, e.message);
    }
  }

  setupMiddleWare(handler: RequestHandler) {
    this.plugins.push(handler);
  }

  private handleHttpOptions(
    route: AssignedRoute,
    router: RoutingEntry,
    res: AdaptedResponse,
  ) {
    if (route.info.corsId == null) {
      throw new AppException(405, 'Method not allowed');
    } else {
      const corsInfo = router.getCorsInfo(route.info.corsId);
      if (corsInfo != null && corsInfo.options.size > 0) {
        for (const h of corsInfo.options.keys()) {
          const prettyHeader = this.getHeaderCase(h);
          if (prettyHeader != null) {
            res.setHeader(prettyHeader, corsInfo.options.get(h));
          }
        }
        // set status to "HTTP-204: No content"
        res.statusCode = 204;
        res.end();
      } else {
        throw new AppException(405, 'Method not allowed');
      }
    }
  }

  private setCorsHeaders(
    route: AssignedRoute,
    router: RoutingEntry,
    res: AdaptedResponse,
  ) {
    const corsInfo = router.getCorsInfo(route.info.corsId);
    if (corsInfo != null && corsInfo.headers.size > 0) {
      for (const h of corsInfo.headers.keys()) {
        const prettyHeader = this.getHeaderCase(h);
        if (prettyHeader != null) {
          res.setHeader(prettyHeader, corsInfo.headers.get(h));
        }
      }
    }
  }

  private validateAuthService(
    route: AssignedRoute,
    req: AdaptedRequest,
  ): string {
    let authService: string = null;
    const authHeaders = route.info.authHeaders;
    if (authHeaders.length > 0) {
      for (const h of authHeaders) {
        const v = req.header(h);
        if (v) {
          let svc = route.info.getAuthService(h);
          svc ??= route.info.getAuthService(h, v);
          if (svc != null) {
            authService = svc;
            break;
          }
        }
      }
    }
    authService ??= route.info.defaultAuthService;
    if (!po.exists(authService)) {
      throw new AppException(503, `Service ${authService} not reachable`);
    }
    return authService;
  }

  private handleUpload(
    req: AdaptedRequest,
    res: AdaptedResponse,
    route: AssignedRoute,
    httpReq: AsyncHttpRequest,
    parameters: RelayParameters,
  ) {
    const bb = busboy({ headers: req._nodeReq.headers });
    let len = 0;
    bb.on('file', (name, file, info) => {
      const stream = new ObjectStreamIO(route.info.timeoutSeconds);
      const outputStream = new ObjectStreamWriter(stream.getOutputStreamId());
      file
        .on('data', (data) => {
          len += data.length;
          outputStream.write(data);
        })
        .on('close', () => {
          httpReq
            .setStreamRoute(stream.getInputStreamId())
            .setFileName(info.filename)
            .setContentLength(len)
            .setUploadTag(name);
          outputStream.close();
        });
    });
    bb.on('field', (name, value) => {
      httpReq.setQueryParameter(name, value);
    });
    bb.on('close', () => {
      this.relay(parameters).catch((e) => {
        const rc = e instanceof AppException ? e.getStatus() : 500;
        this.rejectRequest(res, rc, e.message);
      });
    });
    bb.on('error', (_e) => {
      this.rejectRequest(res, 500, 'Unexpected upload exception');
      log.error(`Unexpected upload exception`);
    });
    req._nodeReq.pipe(bb);
  }

  private parseQuery(req: AdaptedRequest, httpReq: AsyncHttpRequest): string {
    let qs = '';
    for (const k in req.query) {
      const v = req.query[k];
      if (typeof v == 'string') {
        httpReq.setQueryParameter(k, v);
        qs += '&' + k + '=' + v;
      }
    }
    if (qs) {
      qs = qs.substring(1);
    }
    return qs;
  }

  private prepareHttpRequest(
    uriPath: string,
    req: AdaptedRequest,
    route: AssignedRoute,
    router: RoutingEntry,
  ): AsyncHttpRequest {
    const method = req.method;
    const httpReq = new AsyncHttpRequest();
    const qs = this.parseQuery(req, httpReq);
    httpReq.setUrl(this.normalizeUrl(uriPath, route.info.urlRewrite));
    httpReq.setQueryString(qs);
    if (route.info.host) {
      httpReq.setTargetHost(route.info.host);
      httpReq.setTrustAllCert(route.info.trustAllCert);
    }
    httpReq.setMethod(method);
    httpReq.setSecure(HTTPS == req.header(PROTOCOL));
    httpReq.setTimeoutSeconds(route.info.timeoutSeconds);
    if (route.arguments.size > 0) {
      for (const p of route.arguments.keys()) {
        httpReq.setPathParameter(p, route.arguments.get(p));
      }
    }
    let reqHeaders = {};
    for (const h in req.headers) {
      const lh = h.toLowerCase();
      if (lh != 'cookie') {
        reqHeaders[lh] = req.header(h);
      }
    }
    for (const k in req.cookies) {
      const v = req.cookies[k];
      if (typeof v == 'string') {
        httpReq.setCookie(k, v);
      }
    }
    if (route.info.requestTransformId != null) {
      reqHeaders = this.filterHeaders(
        router.getRequestHeaderInfo(route.info.requestTransformId),
        reqHeaders,
      );
    }
    for (const h in reqHeaders) {
      httpReq.setHeader(h, reqHeaders[h]);
    }
    if (route.info.flowId != null) {
      httpReq.setHeader('x-flow-id', route.info.flowId);
    }
    const ip = String(
      req.headers['x-forwarded-for'] || req.socket.remoteAddress,
    );
    httpReq.setRemoteIp(ip);
    return httpReq;
  }

  private handleRequestPayload(
    req: AdaptedRequest,
    res: AdaptedResponse,
    route: AssignedRoute,
    httpReq: AsyncHttpRequest,
    parameters: RelayParameters,
  ): boolean {
    const method = req.method;
    const contentType =
      resolver.getContentType(req.header(CONTENT_TYPE)) || TEXT_PLAIN;
    if (
      contentType.startsWith(MULTIPART_FORM_DATA) &&
      'POST' == method &&
      route.info.upload
    ) {
      this.handleUpload(req, res, route, httpReq, parameters);
      return true;
    } else if (contentType.startsWith(APPLICATION_URL_ENCODED)) {
      for (const k in req.body as object) {
        httpReq.setQueryParameter(k, (req.body as Record<string, string>)[k]);
      }
    } else if (req.body) {
      httpReq.setBody(req.body);
    }
    return false;
  }

  private async processRequest(
    uriPath: string,
    req: AdaptedRequest,
    res: AdaptedResponse,
    route: AssignedRoute,
    router: RoutingEntry,
  ) {
    const method = req.method;
    if (OPTIONS_METHOD == method) {
      this.handleHttpOptions(route, router, res);
      return;
    }
    // set cors headers
    if (route.info.corsId) {
      this.setCorsHeaders(route, router, res);
    }
    // check rate limit before processing
    if (route.info.rateLimitCount > 0) {
      const rlKey = method + ':' + route.info.url;
      if (
        !RateLimiter.getInstance().allow(
          rlKey,
          route.info.rateLimitCount,
          route.info.rateLimitWindowMs,
        )
      ) {
        throw new AppException(429, 'Too many requests');
      }
    }
    // check if target service is available
    if (!po.exists(route.info.primary)) {
      throw new AppException(
        503,
        `Service ${route.info.primary} not reachable`,
      );
    }
    const authService: string = route.info.defaultAuthService
      ? this.validateAuthService(route, req)
      : null;
    const httpReq = this.prepareHttpRequest(uriPath, req, route, router);
    // Distributed tracing required?
    let traceId: string = null;
    let tracePath: string = null;
    let traceHeaderLabel: string = null;
    // Set trace header if needed
    if (route.info.tracing) {
      const traceHeader = this.getTraceId(req);
      traceHeaderLabel = traceHeader[0];
      traceId = traceHeader[1];
      tracePath = method + ' ' + uriPath;
      if (httpReq.getQueryString()) {
        tracePath += '?' + httpReq.getQueryString();
      }
    }
    const parameters = new RelayParameters();
    parameters.authService = authService;
    parameters.traceId = traceId;
    parameters.tracePath = tracePath;
    parameters.traceHeaderLabel = traceHeaderLabel;
    parameters.route = route;
    parameters.req = req;
    parameters.res = res;
    parameters.router = router;
    parameters.httpReq = httpReq;
    if (
      ('POST' == method || 'PUT' == method || 'PATCH' == method) &&
      this.handleRequestPayload(req, res, route, httpReq, parameters)
    ) {
      return;
    }
    await this.relay(parameters);
  }

  async relay(p: RelayParameters) {
    if (p.authService) {
      const authRequest = new EventEnvelope()
        .setTo(p.authService)
        .setFrom('http.request')
        .setBody(p.httpReq.toMap());
      if (p.traceId) {
        authRequest.setTraceId(p.traceId);
        authRequest.setTracePath(p.tracePath);
      }
      const authResponse = await po.request(
        authRequest,
        p.route.info.timeoutSeconds * 1000,
      );
      const approved =
        typeof authResponse.getBody() == 'boolean'
          ? authResponse.getBody()
          : false;
      if (!approved) {
        throw new AppException(401, 'Unauthorized');
      }
      for (const k in authResponse.getHeaders()) {
        const v = authResponse.getHeader(k);
        p.httpReq.setSessionInfo(k, v);
      }
    }
    const serviceRequest = new EventEnvelope()
      .setTo(p.route.info.primary)
      .setFrom('http.request')
      .setBody(p.httpReq.toMap());
    if (p.traceId) {
      serviceRequest.setTraceId(p.traceId);
      serviceRequest.setTracePath(p.tracePath);
    }
    // copy to secondary addresses if any
    if (p.route.info.services.length > 1) {
      copyToSecondaryTarget(p);
    }
    // send request to target service with async.http.response as callback
    const contextId = util.getUuid();
    const timeoutMs = p.route.info.timeoutSeconds * 1000;
    const timeoutEvent = new EventEnvelope()
      .setTo(ASYNC_HTTP_RESPONSE)
      .setCorrelationId(contextId)
      .setStatus(408)
      .setBody(`Timeout for ${p.route.info.timeoutSeconds} seconds`);
    // install future event to catch timeout of the target service
    const watcher = po.sendLater(timeoutEvent, timeoutMs);
    httpContext[contextId] = {
      req: p.req,
      res: p.res,
      http: p.httpReq,
      route: p.route,
      router: p.router,
      label: p.traceHeaderLabel,
      watcher: watcher,
    };
    serviceRequest.setCorrelationId(contextId).setReplyTo(ASYNC_HTTP_RESPONSE);
    await po.send(serviceRequest);
  }

  getReadTimeout(timeoutOverride: string, contextTimeout: number) {
    if (timeoutOverride == null) {
      return contextTimeout;
    }
    // convert to milliseconds
    const timeout = util.str2int(timeoutOverride) * 1000;
    if (timeout < 1) {
      return contextTimeout;
    }
    return Math.min(timeout, contextTimeout);
  }

  normalizeUrl(url: string, urlRewrite: Array<string>): string {
    if (urlRewrite && urlRewrite.length == 2) {
      if (url.startsWith(urlRewrite[0])) {
        return urlRewrite[1] + url.substring(urlRewrite[0].length);
      }
    }
    return url;
  }

  getHeaderCase(header: string): string {
    const sb = new StringBuilder();
    const parts = header.split('-').filter((v) => v.length > 0);
    for (const p of parts) {
      sb.append(p.substring(0, 1).toUpperCase());
      if (p.length > 1) {
        sb.append(p.substring(1).toLowerCase());
      }
      sb.append('-');
    }
    const text = sb.getValue();
    return text.length == 0 ? null : text.substring(0, text.length - 1);
  }

  filterHeaders(headerInfo: HeaderInfo, headers: object): object {
    let result = headers;
    if (headerInfo.keepHeaders != null && headerInfo.keepHeaders.length > 0) {
      // drop all headers except those to be kept
      result = keepSomeHeaders(headerInfo, headers);
    } else if (
      headerInfo.dropHeaders != null &&
      headerInfo.dropHeaders.length > 0
    ) {
      // drop the headers according to "drop" list
      result = dropSomeHeaders(headerInfo, headers);
    }
    if (
      headerInfo.additionalHeaders != null &&
      headerInfo.additionalHeaders.size > 0
    ) {
      for (const h of headerInfo.additionalHeaders.keys()) {
        result[h] = headerInfo.additionalHeaders.get(h);
      }
    }
    return result;
  }

  getTraceId(req: AdaptedRequest): Array<string> {
    const result = new Array<string>();
    for (const label of this.traceIdLabels) {
      const id = req.header(label);
      if (id) {
        result.push(label);
        result.push(id);
      }
    }
    if (result.length == 0) {
      result.push(this.traceIdLabels[0]);
      result.push(util.getUuid());
    }
    return result;
  }

  rejectRequest(res: AdaptedResponse, rc: number, message: string): void {
    const result = { type: 'error', status: rc, message: message };
    res.status(rc).json(result);
  }

  close(): Promise<boolean> {
    return new Promise((resolve) => {
      if (running && server) {
        let n = 0;
        const sessions = Array.from(this.connections.keys());
        for (const c of sessions) {
          const socket = this.connections.get(c);
          socket.destroy();
          n++;
        }
        if (n > 0) {
          const s = n == 1 ? '' : 's';
          log.info(`Total ${n} active HTTP session${s} closed`);
        }
        server.close(() => {
          log.info('REST automation service stopped');
          running = false;
          resolve(true);
        });
      } else {
        resolve(false);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Plugin runner — executes Express-style middleware (req, res, next) on the
// raw Node.js IncomingMessage / ServerResponse pair.
// ---------------------------------------------------------------------------

function runPlugins(
  plugins: RequestHandler[],
  nodeReq: IncomingMessage,
  nodeRes: ServerResponse,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let index = 0;
    // Cast to Express types — the actual objects are IncomingMessage/ServerResponse
    // which implement the same interface subset the plugins use.
    const req = nodeReq as unknown as Request;
    const res = nodeRes as unknown as Response;
    function next(err?: unknown) {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (index >= plugins.length) {
        resolve();
        return;
      }
      const plugin = plugins[index++];
      try {
        plugin(req, res, next);
      } catch (e) {
        reject(e);
      }
    }
    next();
  });
}
