import fs from 'fs';
import path from 'path';
import { Utility } from './utility.js';

const util = new Utility();
const EXPORT_TAG = 'export ';

export interface ScannedComposable {
  kind: 'class' | 'definition';
  file: string;
  exportName: string;
  parameters: Array<string>;
  method?: string;
  parents?: object;
}

export interface ScannedComposableMap {
  [key: string]: ScannedComposable;
}

export interface ScannedComposableResult {
  classes?: Record<string, string>;
  parents?: Record<string, object>;
  parameters?: Record<string, Array<string>>;
  methods?: Record<string, string>;
  composables?: ScannedComposableMap;
}

export interface GeneratedPreloadCode {
  importStatements: string;
  serviceList: string;
  composableList: string;
}

function findClosingBrace(text: string, start: number): number {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else if (ch == quote) {
        quote = '';
      }
      continue;
    }
    if (ch == "'" || ch == '"' || ch == '`') {
      quote = ch;
      continue;
    }
    if (ch == '{') {
      depth++;
      continue;
    }
    if (ch == '}') {
      depth--;
      if (depth == 0) {
        return i;
      }
    }
  }
  return -1;
}

function findTopLevelColon(entry: string): number {
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else if (ch == quote) {
        quote = '';
      }
      continue;
    }
    if (ch == "'" || ch == '"' || ch == '`') {
      quote = ch;
      continue;
    }
    if (ch == '{') {
      braces++;
    } else if (ch == '}') {
      braces--;
    } else if (ch == '[') {
      brackets++;
    } else if (ch == ']') {
      brackets--;
    } else if (ch == '(') {
      parens++;
    } else if (ch == ')') {
      parens--;
    } else if (ch == ':' && braces == 0 && brackets == 0 && parens == 0) {
      return i;
    }
  }
  return -1;
}

function splitTopLevelProperties(text: string): Array<string> {
  const result = new Array<string>();
  let braces = 0;
  let brackets = 0;
  let parens = 0;
  let quote = '';
  let escaped = false;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    current += ch;
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else if (ch == quote) {
        quote = '';
      }
      continue;
    }
    if (ch == "'" || ch == '"' || ch == '`') {
      quote = ch;
      continue;
    }
    if (ch == '{') {
      braces++;
    } else if (ch == '}') {
      braces--;
    } else if (ch == '[') {
      brackets++;
    } else if (ch == ']') {
      brackets--;
    } else if (ch == '(') {
      parens++;
    } else if (ch == ')') {
      parens--;
    } else if (ch == ',' && braces == 0 && brackets == 0 && parens == 0) {
      const entry = current.substring(0, current.length - 1).trim();
      if (entry) {
        result.push(entry);
      }
      current = '';
    }
  }
  const tail = current.trim();
  if (tail) {
    result.push(tail);
  }
  return result;
}

function getComposableParameters(
  content: string,
  matchIndex: number,
): Array<string> | null {
  const openBrace = content.indexOf('{', matchIndex);
  if (openBrace == -1) {
    return null;
  }
  const closeBrace = findClosingBrace(content, openBrace);
  if (closeBrace == -1) {
    return null;
  }
  const body = content.substring(openBrace + 1, closeBrace);
  const props = splitTopLevelProperties(body);
  const metadata: Record<string, string> = {};
  for (const prop of props) {
    const colon = findTopLevelColon(prop);
    if (colon == -1) {
      continue;
    }
    const key = prop.substring(0, colon).trim();
    const value = prop.substring(colon + 1).trim();
    if (key && value) {
      metadata[key] = value;
    }
  }
  if (!metadata['process']) {
    return null;
  }
  return [
    metadata['process'],
    metadata['instances'] ?? '1',
    metadata['visibility'] ?? 'private',
    metadata['interceptor'] ?? 'false',
  ];
}

export function scanComposableDefinitions(
  content: string,
): Array<{ key: string; exportName: string; parameters: Array<string> }> {
  const result = new Array<{
    key: string;
    exportName: string;
    parameters: Array<string>;
  }>();
  const seen = new Set<number>();

  const directDefault = /export\s+default\s+defineComposable\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = directDefault.exec(content)) != null) {
    const parameters = getComposableParameters(content, match.index);
    if (parameters) {
      result.push({
        key: `default#${match.index}`,
        exportName: 'default',
        parameters,
      });
      seen.add(match.index);
    }
  }

  const assigned =
    /(?:^|\n)\s*(export\s+const|const)\s+([A-Za-z_$][\w$]*)\s*=\s*defineComposable\s*\(/g;
  while ((match = assigned.exec(content)) != null) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0);
    if (seen.has(start)) {
      continue;
    }
    const symbol = match[2];
    const parameters = getComposableParameters(content, start);
    if (parameters) {
      const exportedAsDefault = new RegExp(
        `export\\s+default\\s+${symbol}\\b`,
      ).test(content);
      const exportName =
        match[1] == 'export const'
          ? symbol
          : exportedAsDefault
            ? 'default'
            : symbol;
      result.push({ key: symbol, exportName, parameters });
      seen.add(start);
    }
  }

  return result;
}

export class ClassScanUtility {
  static getParams(text: string): Array<string> {
    const start = text.indexOf('(');
    const end = text.indexOf(')');
    if (end > start) {
      const inner = text.substring(start + 1, end);
      return util.split(inner, ', ');
    } else {
      return new Array<string>();
    }
  }

  static list2str(list: Array<string>): string {
    let result = '';
    for (const item of list) {
      result += item;
      result += ', ';
    }
    return result.length > 2 ? result.substring(0, result.length - 2) : result;
  }

  static generatePreloadCode(
    result: ScannedComposableResult,
    preloadFolder = 'src/preload',
  ): GeneratedPreloadCode {
    const composables = result?.composables ?? {};
    const classEntries = Object.entries(composables)
      .filter(([, composable]) => composable.kind == 'class')
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
    const definitionEntries = Object.entries(composables)
      .filter(([, composable]) => composable.kind == 'definition')
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));

    const usedSymbols = new Set<string>();
    const classProcesses = new Set<string>();
    const imports = new Array<string>();
    const serviceList = new Array<string>();
    const composableList = new Array<string>();

    for (const [, composable] of classEntries) {
      if (!composable.parameters?.length) {
        continue;
      }
      const route = composable.parameters[0];
      classProcesses.add(route);
      const symbol = this.allocateSymbol(composable.exportName, usedSymbols);
      imports.push(
        `import { ${composable.exportName}${symbol != composable.exportName ? ` as ${symbol}` : ''} } from '${this.getImportPath(composable.file, preloadFolder)}';`,
      );
      const args = [route, `new ${symbol}()`].concat(
        composable.parameters.slice(1),
      );
      serviceList.push(`platform.register(${args.join(', ')});`);
    }

    for (const [key, composable] of definitionEntries) {
      if (!composable.parameters?.length) {
        continue;
      }
      const route = composable.parameters[0];
      if (classProcesses.has(route)) {
        continue;
      }
      const baseSymbol =
        composable.exportName == 'default'
          ? this.getDefaultImportName(key, composable.file)
          : composable.exportName;
      const symbol = this.allocateSymbol(baseSymbol, usedSymbols);
      const importPath = this.getImportPath(composable.file, preloadFolder);
      if (composable.exportName == 'default') {
        imports.push(`import ${symbol} from '${importPath}';`);
      } else {
        imports.push(
          `import { ${composable.exportName}${symbol != composable.exportName ? ` as ${symbol}` : ''} } from '${importPath}';`,
        );
      }
      composableList.push(`platform.registerComposable(${symbol});`);
    }

    return {
      importStatements: imports.join('\n'),
      serviceList: serviceList.join('\n                '),
      composableList: composableList.join('\n                '),
    };
  }

  private static getImportPath(file: string, preloadFolder: string): string {
    const normalizedFile = file.replaceAll('\\', '/');
    const target = normalizedFile.endsWith('.js')
      ? normalizedFile
      : `${normalizedFile}.js`;
    const fromFolder = preloadFolder.replaceAll('\\', '/');
    const relative = path.posix.relative(fromFolder, target);
    return relative.startsWith('.') ? relative : `./${relative}`;
  }

  private static getDefaultImportName(key: string, file: string): string {
    const logicalName = key.includes('@')
      ? key.substring(0, key.indexOf('@'))
      : key;
    if (
      logicalName &&
      logicalName != 'default' &&
      !logicalName.startsWith('default#')
    ) {
      return this.toIdentifier(logicalName);
    }
    const parts = file.replaceAll('\\', '/').split('/');
    const fileName = parts[parts.length - 1];
    const basename = fileName.endsWith('.js')
      ? fileName.substring(0, fileName.length - 3)
      : fileName;
    return this.toIdentifier(basename);
  }

  private static toIdentifier(value: string): string {
    const cleaned = value.replace(
      /[^A-Za-z0-9_$]+(.)?/g,
      (_, chr: string | undefined) => (chr ? chr.toUpperCase() : ''),
    );
    const normalized = cleaned
      ? cleaned[0].toLowerCase() + cleaned.substring(1)
      : 'composable';
    return /^[A-Za-z_$]/.test(normalized)
      ? normalized
      : `composable${normalized}`;
  }

  private static allocateSymbol(
    base: string,
    usedSymbols: Set<string>,
  ): string {
    let symbol = /^[A-Za-z_$][\w$]*$/.test(base)
      ? base
      : this.toIdentifier(base);
    if (!symbol) {
      symbol = 'composable';
    }
    let candidate = symbol;
    let counter = 2;
    while (usedSymbols.has(candidate)) {
      candidate = `${symbol}${counter}`;
      counter++;
    }
    usedSymbols.add(candidate);
    return candidate;
  }
}

export class TypeScriptClassScanner {
  private readonly parentFolder: string;
  private readonly tsFolder: string;
  private readonly methodAnnotation: string;
  private clsMap = {};
  private clsParents = {};
  private clsParameters = {};
  private clsMethods = {};
  private composables = {};

  constructor(
    parentFolder: string,
    tsFolder: string,
    methodAnnotation: string,
  ) {
    this.parentFolder = parentFolder || 'null/';
    this.tsFolder = this.parentFolder + (tsFolder || 'null');
    this.methodAnnotation = methodAnnotation
      ? `@${methodAnnotation}`
      : '@undefined';
  }

  async scan() {
    await this.scanSource(this.parentFolder, this.tsFolder);
    return {
      classes: this.clsMap,
      parents: this.clsParents,
      parameters: this.clsParameters,
      methods: this.clsMethods,
      composables: this.composables,
    };
  }

  private async scanSource(parent: string, folder: string) {
    const files = await fs.promises.readdir(folder);
    for (const f of files) {
      const filePath = `${folder}/${f}`;
      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) {
        await this.scanSource(parent, filePath);
      } else if (f.endsWith('.ts') && !f.endsWith('.d.ts')) {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        const lines = content
          .split('\n')
          .map((v) => v.trim())
          .filter((v) => v);
        const clsList = this.scanSourceCode(lines);
        const relativePath = `${filePath.substring(parent.length, filePath.length - 3)}`;
        if (clsList.length > 0) {
          this.clsMap[ClassScanUtility.list2str(clsList)] = relativePath;
          for (const clsName of clsList) {
            this.composables[clsName] = {
              kind: 'class',
              file: relativePath,
              exportName: clsName,
              parameters: this.clsParameters[clsName] ?? [],
              method: this.clsMethods[clsName],
              parents: this.clsParents[clsName] ?? null,
            } satisfies ScannedComposable;
          }
        }
        const definitions = scanComposableDefinitions(content);
        for (const definition of definitions) {
          const key = `${definition.key}@${relativePath}`;
          this.composables[key] = {
            kind: 'definition',
            file: relativePath,
            exportName: definition.exportName,
            parameters: definition.parameters,
          } satisfies ScannedComposable;
        }
      }
    }
  }

  private scanSourceCode(lines: Array<string>) {
    const clsList = new Array<string>();
    const md = new ClassMetadata();
    for (const line of lines) {
      const statement = this.getAnnotation(line);
      if (statement) {
        if (EXPORT_TAG == md.signature && statement.startsWith(EXPORT_TAG)) {
          this.parseExportTag(statement, md);
        } else if (
          this.methodAnnotation == md.signature &&
          statement.startsWith(this.methodAnnotation) &&
          statement.includes('(') &&
          statement.includes(')')
        ) {
          md.store.push(ClassScanUtility.getParams(statement));
        } else if (
          this.methodAnnotation == md.signature &&
          md.store.length > 0 &&
          md.clsName &&
          statement.includes('(') &&
          statement.includes(')')
        ) {
          const parts = util.split(statement, '() :{');
          if (parts.length > 0) {
            this.parseMethod(parts, clsList, md);
            md.signature = EXPORT_TAG;
          }
        }
      }
    }
    return clsList;
  }

  private getAnnotation(statement: string): string {
    if (statement.startsWith('//')) {
      const text = statement.substring(2).trim();
      if (text.startsWith(this.methodAnnotation)) {
        return text;
      } else {
        return null;
      }
    } else {
      return statement;
    }
  }

  private parseExportTag(line: string, md: ClassMetadata) {
    const parts: Array<string> = util.split(line, ', {');
    if (parts.length >= 3 && 'class' == parts[1]) {
      md.clsName = parts[2];
      md.signature = this.methodAnnotation;
      if (parts.length > 3) {
        const inheritance = new Array<string>();
        for (let i = 3; i < parts.length; i++) {
          inheritance.push(parts[i]);
        }
        const extendsParents = new Array<string>();
        const implementsParents = new Array<string>();
        if (inheritance.length > 0) {
          this.parseInheritance(inheritance, extendsParents, implementsParents);
        }
        md.parents = { extends: extendsParents, implements: implementsParents };
      }
    }
  }

  private parseInheritance(
    inheritance: Array<string>,
    extendsParents: Array<string>,
    implementsParents: Array<string>,
  ) {
    let mode = '';
    for (const item of inheritance) {
      if (item == 'extends') {
        mode = 'extends';
      } else if (item == 'implements') {
        mode = 'implements';
      } else if ('extends' == mode) {
        extendsParents.push(item);
      } else if ('implements' == mode) {
        implementsParents.push(item);
      }
    }
  }

  private parseMethod(
    parts: Array<string>,
    clsList: Array<string>,
    md: ClassMetadata,
  ) {
    clsList.push(md.clsName);
    const metadata = md.store.pop();
    if (metadata) {
      this.clsParameters[md.clsName] = metadata;
    }
    if (md.parents) {
      this.clsParents[md.clsName] = md.parents;
    }
    this.clsMethods[md.clsName] = parts[0];
    md.clsName = null;
    md.parents = null;
  }
}

class ClassMetadata {
  store = new Array<Array<string>>();
  clsName: string = null;
  parents: object = null;
  signature: string = EXPORT_TAG;
}
