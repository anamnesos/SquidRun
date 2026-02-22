/**
 * Automated Documentation Generator - Task #23
 *
 * Generates documentation from code by analyzing:
 * - JSDoc comments
 * - Function signatures and parameters
 * - Type annotations (TypeScript/JSDoc)
 * - Module structure and exports
 * - Class definitions and methods
 * - Constants and configuration
 *
 * Output formats:
 * - Markdown documentation
 * - JSON API reference
 * - HTML documentation
 */

const fs = require('fs');
const path = require('path');

// Documentation element types
const DOC_TYPES = {
  MODULE: 'module',
  FUNCTION: 'function',
  CLASS: 'class',
  METHOD: 'method',
  PROPERTY: 'property',
  CONSTANT: 'constant',
  TYPE: 'type',
  INTERFACE: 'interface',
  ENUM: 'enum',
  EVENT: 'event',
};

/**
 * Main documentation generator class
 */
class DocGenerator {
  constructor(options = {}) {
    this.outputDir = options.outputDir || './docs/api';
    this.includePrivate = options.includePrivate || false;
    this.includeSource = options.includeSource || false;
    this.format = options.format || 'markdown';
    this.projectName = options.projectName || 'API Documentation';
    this.version = options.version || '1.0.0';
  }

  /**
   * Generate documentation for a file
   */
  async generateForFile(filePath) {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' };
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const ext = path.extname(filePath).toLowerCase();

      let elements = [];

      if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
        elements = this.parseJavaScript(content, filePath);
      } else if (ext === '.ts' || ext === '.tsx') {
        elements = this.parseTypeScript(content, filePath);
      } else if (ext === '.json') {
        elements = this.parseJSON(content, filePath);
      } else {
        return { success: false, error: 'Unsupported file type' };
      }

      const doc = this.buildDocumentation(elements, filePath);

      return {
        success: true,
        filePath,
        elements,
        documentation: doc,
        stats: {
          functions: elements.filter(e => e.type === DOC_TYPES.FUNCTION).length,
          classes: elements.filter(e => e.type === DOC_TYPES.CLASS).length,
          constants: elements.filter(e => e.type === DOC_TYPES.CONSTANT).length,
          exports: elements.filter(e => e.exported).length,
        },
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Generate documentation for a directory
   */
  async generateForDirectory(dirPath, options = {}) {
    const { recursive = true, pattern = /\.(js|ts|mjs)$/, ignore = /node_modules|\.test\.|\.spec\./ } = options;

    const files = this.findFiles(dirPath, pattern, ignore, recursive);
    const results = [];
    const allElements = [];

    for (const file of files) {
      const result = await this.generateForFile(file);
      if (result.success) {
        results.push(result);
        allElements.push(...result.elements.map(e => ({ ...e, file })));
      }
    }

    // Generate index/table of contents
    const index = this.buildIndex(results, dirPath);

    return {
      success: true,
      files: results.length,
      totalElements: allElements.length,
      results,
      index,
      sourceDir: dirPath,
      stats: this.calculateStats(allElements),
    };
  }

  /**
   * Find files matching pattern
   */
  findFiles(dirPath, pattern, ignore, recursive) {
    const files = [];

    const scan = (dir) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_err) {
        // Skip unreadable or transient directories instead of aborting the whole run.
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (ignore && ignore.test(fullPath)) continue;

        if (entry.isDirectory() && recursive) {
          scan(fullPath);
        } else if (entry.isFile() && pattern.test(entry.name)) {
          files.push(fullPath);
        }
      }
    };

    scan(dirPath);
    return files;
  }

  /**
   * Parse JavaScript file
   */
  parseJavaScript(content, filePath) {
    const elements = [];
    const lines = content.split('\n');

    // Track module-level info
    const moduleDoc = this.extractModuleDoc(content);
    if (moduleDoc) {
      elements.push({
        type: DOC_TYPES.MODULE,
        name: path.basename(filePath, path.extname(filePath)),
        description: moduleDoc.description,
        tags: moduleDoc.tags,
        line: 1,
      });
    }

    // Parse JSDoc comments and their targets
    const jsdocBlocks = this.extractJSDocBlocks(content);

    for (const block of jsdocBlocks) {
      const element = this.parseJSDocBlock(block, lines);
      if (element) {
        elements.push(element);
      }
    }

    // Parse standalone functions without JSDoc
    const functions = this.extractFunctions(content);
    for (const func of functions) {
      // Check if already documented
      if (!elements.find(e => e.name === func.name && e.type === DOC_TYPES.FUNCTION)) {
        elements.push(func);
      }
    }

    // Parse classes
    const classes = this.extractClasses(content);
    elements.push(...classes);

    // Parse exports
    const exports = this.extractExports(content);
    this.markExported(elements, exports);

    // Parse constants
    const constants = this.extractConstants(content);
    elements.push(...constants);

    return elements;
  }

  /**
   * Parse TypeScript file (simplified - treats as JS with type annotations)
   */
  parseTypeScript(content, filePath) {
    // For now, parse as JavaScript but also extract type annotations
    const elements = this.parseJavaScript(content, filePath);

    // Extract interfaces
    const interfaces = this.extractInterfaces(content);
    elements.push(...interfaces);

    // Extract type aliases
    const types = this.extractTypeAliases(content);
    elements.push(...types);

    return elements;
  }

  /**
   * Parse JSON file (for config documentation)
   */
  parseJSON(content, filePath) {
    try {
      const data = JSON.parse(content);
      const elements = [];

      elements.push({
        type: DOC_TYPES.MODULE,
        name: path.basename(filePath),
        description: 'Configuration file',
        properties: this.documentJSONProperties(data),
        line: 1,
      });

      return elements;
    } catch {
      return [];
    }
  }

  /**
   * Extract module-level JSDoc comment
   */
  extractModuleDoc(content) {
    const match = content.match(/^\/\*\*\s*\n([\s\S]*?)\*\//m);
    if (!match) return null;

    return this.parseJSDocComment(match[0]);
  }

  /**
   * Extract all JSDoc blocks with their positions
   */
  extractJSDocBlocks(content) {
    const blocks = [];
    const regex = /\/\*\*\s*\n([\s\S]*?)\*\/\s*\n\s*(.+)/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const startLine = content.slice(0, match.index).split('\n').length;
      blocks.push({
        comment: match[0].split('\n').slice(0, -1).join('\n') + '\n*/',
        target: match[2],
        line: startLine,
        index: match.index,
      });
    }

    return blocks;
  }

  /**
   * Parse a JSDoc block and its target
   */
  parseJSDocBlock(block, _lines) {
    const doc = this.parseJSDocComment(block.comment);
    const target = block.target.trim();

    // Determine what the JSDoc is documenting
    let element = null;

    // Function
    if (target.match(/^(async\s+)?function\s+(\w+)|^(const|let|var)\s+(\w+)\s*=\s*(async\s+)?\(|^(const|let|var)\s+(\w+)\s*=\s*(async\s+)?function/)) {
      const nameMatch = target.match(/function\s+(\w+)|(?:const|let|var)\s+(\w+)/);
      const name = nameMatch ? (nameMatch[1] || nameMatch[2]) : 'anonymous';

      element = {
        type: DOC_TYPES.FUNCTION,
        name,
        description: doc.description,
        params: doc.tags.filter(t => t.tag === 'param').map(t => ({
          name: t.name,
          type: t.type,
          description: t.description,
          optional: t.optional,
          default: t.default,
        })),
        returns: doc.tags.find(t => t.tag === 'returns' || t.tag === 'return'),
        throws: doc.tags.filter(t => t.tag === 'throws' || t.tag === 'throw'),
        examples: doc.tags.filter(t => t.tag === 'example').map(t => t.description),
        deprecated: doc.tags.find(t => t.tag === 'deprecated'),
        async: target.includes('async'),
        line: block.line,
      };
    }
    // Class
    else if (target.match(/^class\s+(\w+)/)) {
      const nameMatch = target.match(/class\s+(\w+)/);
      element = {
        type: DOC_TYPES.CLASS,
        name: nameMatch[1],
        description: doc.description,
        extends: doc.tags.find(t => t.tag === 'extends')?.type,
        implements: doc.tags.filter(t => t.tag === 'implements').map(t => t.type),
        line: block.line,
      };
    }
    // Constant
    else if (target.match(/^(const|let|var)\s+(\w+)\s*=/)) {
      const nameMatch = target.match(/(?:const|let|var)\s+(\w+)/);
      element = {
        type: DOC_TYPES.CONSTANT,
        name: nameMatch[1],
        description: doc.description,
        constType: doc.tags.find(t => t.tag === 'type')?.type,
        line: block.line,
      };
    }

    return element;
  }

  /**
   * Parse JSDoc comment into structured data
   */
  parseJSDocComment(comment) {
    const lines = comment.split('\n');
    let description = '';
    const tags = [];
    let inDescription = true;

    for (const line of lines) {
      const trimmed = line.replace(/^\s*\*\s?/, '').trim();

      if (trimmed.startsWith('/**') || trimmed === '*/' || trimmed === '*') continue;

      if (trimmed.startsWith('@')) {
        inDescription = false;
        const tag = this.parseJSDocTag(trimmed);
        if (tag) tags.push(tag);
      } else if (inDescription) {
        description += (description ? '\n' : '') + trimmed;
      }
    }

    return { description: description.trim(), tags };
  }

  /**
   * Parse a single JSDoc tag
   */
  parseJSDocTag(line) {
    // @param {Type} name - Description
    const paramMatch = line.match(/@param\s+(?:\{([^}]+)\}\s+)?(?:\[([^\]]+)\]|(\w+))(?:\s+-?\s*(.*))?/);
    if (paramMatch) {
      const name = paramMatch[2] || paramMatch[3];
      const isOptional = !!paramMatch[2];
      let defaultValue = null;
      let cleanName = name;

      if (isOptional && name.includes('=')) {
        [cleanName, defaultValue] = name.split('=').map(s => s.trim());
      }

      return {
        tag: 'param',
        type: paramMatch[1] || 'any',
        name: cleanName,
        description: paramMatch[4] || '',
        optional: isOptional,
        default: defaultValue,
      };
    }

    // @returns {Type} Description
    const returnsMatch = line.match(/@(?:returns?)\s+(?:\{([^}]+)\}\s+)?(.*)/);
    if (returnsMatch) {
      return {
        tag: 'returns',
        type: returnsMatch[1] || 'any',
        description: returnsMatch[2] || '',
      };
    }

    // @throws {Type} Description
    const throwsMatch = line.match(/@(?:throws?)\s+(?:\{([^}]+)\}\s+)?(.*)/);
    if (throwsMatch) {
      return {
        tag: 'throws',
        type: throwsMatch[1] || 'Error',
        description: throwsMatch[2] || '',
      };
    }

    // @type {Type}
    const typeMatch = line.match(/@type\s+\{([^}]+)\}/);
    if (typeMatch) {
      return { tag: 'type', type: typeMatch[1] };
    }

    // @example
    const exampleMatch = line.match(/@example\s*(.*)/);
    if (exampleMatch) {
      return { tag: 'example', description: exampleMatch[1] };
    }

    // Generic tag
    const genericMatch = line.match(/@(\w+)\s*(.*)/);
    if (genericMatch) {
      return { tag: genericMatch[1], description: genericMatch[2] };
    }

    return null;
  }

  /**
   * Extract functions without JSDoc
   */
  extractFunctions(content) {
    const functions = [];
    const regex = /(?:^|\n)\s*(async\s+)?function\s+(\w+)\s*\(([^)]*)\)|(?:^|\n)\s*(?:const|let|var)\s+(\w+)\s*=\s*(async\s+)?(?:function\s*)?\(([^)]*)\)\s*(?:=>|{)/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const name = match[2] || match[4];
      const params = match[3] || match[6] || '';
      const isAsync = !!(match[1] || match[5]);
      const line = content.slice(0, match.index).split('\n').length;

      functions.push({
        type: DOC_TYPES.FUNCTION,
        name,
        description: '',
        params: this.parseParams(params),
        async: isAsync,
        line,
      });
    }

    return functions;
  }

  /**
   * Parse function parameters string
   */
  parseParams(paramsStr) {
    if (!paramsStr.trim()) return [];

    return paramsStr.split(',').map(p => {
      const trimmed = p.trim();
      const defaultMatch = trimmed.match(/(\w+)\s*=\s*(.+)/);
      const destructureMatch = trimmed.match(/\{([^}]+)\}/);

      if (defaultMatch) {
        return {
          name: defaultMatch[1],
          default: defaultMatch[2].trim(),
          optional: true,
        };
      }

      if (destructureMatch) {
        return {
          name: `{ ${destructureMatch[1]} }`,
          destructured: true,
        };
      }

      return { name: trimmed };
    }).filter(p => p.name);
  }

  /**
   * Extract class definitions
   */
  extractClasses(content) {
    const classes = [];
    const classRegex = /class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{/g;
    let match;

    while ((match = classRegex.exec(content)) !== null) {
      const name = match[1];
      const extendsClass = match[2];
      const line = content.slice(0, match.index).split('\n').length;

      // Find class body
      const startIdx = match.index + match[0].length - 1;
      const classBody = this.extractBracketContent(content, startIdx);

      // Extract methods
      const methods = this.extractClassMethods(classBody);

      classes.push({
        type: DOC_TYPES.CLASS,
        name,
        extends: extendsClass,
        methods,
        line,
      });
    }

    return classes;
  }

  /**
   * Extract bracket content (handles nesting)
   */
  extractBracketContent(content, startIdx) {
    let depth = 1;
    let idx = startIdx + 1;

    while (depth > 0 && idx < content.length) {
      if (content[idx] === '{') depth++;
      else if (content[idx] === '}') depth--;
      idx++;
    }

    return content.slice(startIdx + 1, idx - 1);
  }

  /**
   * Extract methods from class body
   */
  extractClassMethods(classBody) {
    const methods = [];
    const methodRegex = /(async\s+)?(\w+)\s*\(([^)]*)\)\s*\{/g;
    let match;

    while ((match = methodRegex.exec(classBody)) !== null) {
      const name = match[2];
      if (name === 'constructor' || name === 'if' || name === 'for' || name === 'while') continue;

      methods.push({
        type: DOC_TYPES.METHOD,
        name,
        params: this.parseParams(match[3]),
        async: !!match[1],
      });
    }

    return methods;
  }

  /**
   * Extract module exports
   */
  extractExports(content) {
    const exports = new Set();

    // module.exports = { ... }
    const moduleExportsMatch = content.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    if (moduleExportsMatch) {
      const items = moduleExportsMatch[1].split(',');
      items.forEach(item => {
        const name = item.trim().split(':')[0].trim();
        if (name) exports.add(name);
      });
    }

    // exports.name = ...
    const namedExports = content.matchAll(/exports\.(\w+)\s*=/g);
    for (const match of namedExports) {
      exports.add(match[1]);
    }

    // export { ... }
    const esExports = content.match(/export\s*\{([^}]+)\}/g);
    if (esExports) {
      esExports.forEach(exp => {
        const match = exp.match(/\{([^}]+)\}/);
        if (match) {
          match[1].split(',').forEach(item => {
            const name = item.trim().split(/\s+as\s+/)[0].trim();
            if (name) exports.add(name);
          });
        }
      });
    }

    // export default
    if (content.includes('export default')) {
      exports.add('default');
    }

    // export function/class/const
    const directExports = content.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)/g);
    for (const match of directExports) {
      exports.add(match[1]);
    }

    return exports;
  }

  /**
   * Mark exported elements
   */
  markExported(elements, exports) {
    for (const element of elements) {
      if (exports.has(element.name)) {
        element.exported = true;
      }
    }
  }

  /**
   * Extract constants
   */
  extractConstants(content) {
    const constants = [];
    const regex = /(?:^|\n)\s*const\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;\n]+)/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      constants.push({
        type: DOC_TYPES.CONSTANT,
        name: match[1],
        value: match[2].trim(),
        line,
      });
    }

    return constants;
  }

  /**
   * Extract TypeScript interfaces
   */
  extractInterfaces(content) {
    const interfaces = [];
    const regex = /interface\s+(\w+)(?:\s+extends\s+([^{]+))?\s*\{([^}]+)\}/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      interfaces.push({
        type: DOC_TYPES.INTERFACE,
        name: match[1],
        extends: match[2]?.trim(),
        properties: this.parseInterfaceProperties(match[3]),
        line,
      });
    }

    return interfaces;
  }

  /**
   * Parse interface properties
   */
  parseInterfaceProperties(body) {
    const props = [];
    const lines = body.split(/[;\n]/).filter(l => l.trim());

    for (const line of lines) {
      const match = line.trim().match(/(\w+)(\?)?\s*:\s*(.+)/);
      if (match) {
        props.push({
          name: match[1],
          optional: !!match[2],
          type: match[3].trim(),
        });
      }
    }

    return props;
  }

  /**
   * Extract TypeScript type aliases
   */
  extractTypeAliases(content) {
    const types = [];
    const regex = /type\s+(\w+)\s*=\s*([^;]+)/g;
    let match;

    while ((match = regex.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      types.push({
        type: DOC_TYPES.TYPE,
        name: match[1],
        definition: match[2].trim(),
        line,
      });
    }

    return types;
  }

  /**
   * Document JSON properties recursively
   */
  documentJSONProperties(obj, prefix = '') {
    const props = [];

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      const valueType = Array.isArray(value) ? 'array' : typeof value;

      props.push({
        name: fullKey,
        type: valueType,
        value: valueType === 'object' ? undefined : JSON.stringify(value),
      });

      if (valueType === 'object' && value !== null) {
        props.push(...this.documentJSONProperties(value, fullKey));
      }
    }

    return props;
  }

  /**
   * Build documentation for elements
   */
  buildDocumentation(elements, filePath) {
    switch (this.format) {
      case 'markdown':
        return this.buildMarkdown(elements, filePath);
      case 'json':
        return this.buildJSON(elements, filePath);
      case 'html':
        return this.buildHTML(elements, filePath);
      default:
        return this.buildMarkdown(elements, filePath);
    }
  }

  /**
   * Build Markdown documentation
   */
  buildMarkdown(elements, filePath) {
    const lines = [];
    const fileName = path.basename(filePath);

    lines.push(`# ${fileName}`);
    lines.push('');

    // Module description
    const moduleDoc = elements.find(e => e.type === DOC_TYPES.MODULE);
    if (moduleDoc?.description) {
      lines.push(moduleDoc.description);
      lines.push('');
    }

    // Table of contents
    const functions = elements.filter(e => e.type === DOC_TYPES.FUNCTION && e.exported);
    const classes = elements.filter(e => e.type === DOC_TYPES.CLASS);
    const constants = elements.filter(e => e.type === DOC_TYPES.CONSTANT && e.exported);

    if (functions.length + classes.length + constants.length > 0) {
      lines.push('## Table of Contents');
      lines.push('');

      if (functions.length > 0) {
        lines.push('### Functions');
        functions.forEach(f => {
          lines.push(`- [${f.name}](#${f.name.toLowerCase()})`);
        });
        lines.push('');
      }

      if (classes.length > 0) {
        lines.push('### Classes');
        classes.forEach(c => {
          lines.push(`- [${c.name}](#${c.name.toLowerCase()})`);
        });
        lines.push('');
      }

      if (constants.length > 0) {
        lines.push('### Constants');
        constants.forEach(c => {
          lines.push(`- [${c.name}](#${c.name.toLowerCase()})`);
        });
        lines.push('');
      }
    }

    // Document functions
    if (functions.length > 0) {
      lines.push('## Functions');
      lines.push('');

      for (const func of functions) {
        lines.push(`### ${func.name}`);
        lines.push('');

        if (func.description) {
          lines.push(func.description);
          lines.push('');
        }

        // Signature
        const params = func.params?.map(p => {
          if (p.optional) return `[${p.name}${p.default ? `=${p.default}` : ''}]`;
          return p.name;
        }).join(', ') || '';

        lines.push('```javascript');
        lines.push(`${func.async ? 'async ' : ''}function ${func.name}(${params})`);
        lines.push('```');
        lines.push('');

        // Parameters
        if (func.params?.length > 0) {
          lines.push('**Parameters:**');
          lines.push('');
          lines.push('| Name | Type | Description |');
          lines.push('|------|------|-------------|');
          func.params.forEach(p => {
            const opt = p.optional ? ' (optional)' : '';
            const def = p.default ? ` Default: \`${p.default}\`` : '';
            lines.push(`| ${p.name} | \`${p.type || 'any'}\` | ${p.description || ''}${opt}${def} |`);
          });
          lines.push('');
        }

        // Returns
        if (func.returns) {
          lines.push(`**Returns:** \`${func.returns.type}\` - ${func.returns.description || ''}`);
          lines.push('');
        }

        // Examples
        if (func.examples?.length > 0) {
          lines.push('**Examples:**');
          lines.push('');
          func.examples.forEach(ex => {
            lines.push('```javascript');
            lines.push(ex);
            lines.push('```');
            lines.push('');
          });
        }

        lines.push('---');
        lines.push('');
      }
    }

    // Document classes
    if (classes.length > 0) {
      lines.push('## Classes');
      lines.push('');

      for (const cls of classes) {
        lines.push(`### ${cls.name}`);
        lines.push('');

        if (cls.extends) {
          lines.push(`Extends: \`${cls.extends}\``);
          lines.push('');
        }

        if (cls.description) {
          lines.push(cls.description);
          lines.push('');
        }

        // Methods
        if (cls.methods?.length > 0) {
          lines.push('**Methods:**');
          lines.push('');
          lines.push('| Method | Parameters |');
          lines.push('|--------|------------|');
          cls.methods.forEach(m => {
            const params = m.params?.map(p => p.name).join(', ') || '';
            lines.push(`| ${m.async ? 'async ' : ''}${m.name} | ${params} |`);
          });
          lines.push('');
        }

        lines.push('---');
        lines.push('');
      }
    }

    // Document constants
    if (constants.length > 0) {
      lines.push('## Constants');
      lines.push('');
      lines.push('| Name | Value | Description |');
      lines.push('|------|-------|-------------|');
      constants.forEach(c => {
        const value = c.value ? `\`${c.value.slice(0, 50)}${c.value.length > 50 ? '...' : ''}\`` : '';
        lines.push(`| ${c.name} | ${value} | ${c.description || ''} |`);
      });
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Build JSON documentation
   */
  buildJSON(elements, filePath) {
    return JSON.stringify({
      file: filePath,
      generated: new Date().toISOString(),
      elements,
    }, null, 2);
  }

  /**
   * Build HTML documentation
   */
  buildHTML(elements, filePath) {
    const markdown = this.buildMarkdown(elements, filePath);
    // Simple markdown to HTML conversion
    return `<!DOCTYPE html>
<html>
<head>
  <title>${path.basename(filePath)} - Documentation</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
    pre { background: #f4f4f4; padding: 16px; border-radius: 6px; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background: #f4f4f4; }
    hr { border: none; border-top: 1px solid #eee; margin: 24px 0; }
  </style>
</head>
<body>
${this.markdownToHTML(markdown)}
</body>
</html>`;
  }

  /**
   * Simple markdown to HTML conversion
   */
  markdownToHTML(md) {
    return md
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/```(\w+)?\n([\s\S]+?)```/g, '<pre><code>$2</code></pre>')
      .replace(/^\|(.+)\|$/gm, (match, content) => {
        const cells = content.split('|').map(c => c.trim());
        const isHeader = cells.every(c => c.match(/^-+$/));
        if (isHeader) return '';
        const tag = content.includes('---') ? 'th' : 'td';
        return '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      })
      .replace(/<tr>.*<\/tr>\n<tr>.*<\/tr>/g, match => `<table>${match}</table>`)
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n)+/g, match => `<ul>${match}</ul>`)
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<)(.+)$/gm, '<p>$1</p>')
      .replace(/<p><\/p>/g, '')
      .replace(/---/g, '<hr>');
  }

  /**
   * Build index for directory documentation
   */
  buildIndex(results, sourceDir = null) {
    const lines = [];

    lines.push(`# ${this.projectName}`);
    lines.push('');
    lines.push(`Version: ${this.version}`);
    lines.push('');
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('## Modules');
    lines.push('');

    for (const result of results) {
      const filePath = String(result.filePath || '');
      const relativePath = sourceDir
        ? path.relative(sourceDir, filePath)
        : path.basename(filePath);
      const normalizedPath = String(relativePath || path.basename(filePath)).split(path.sep).join('/');
      const linkPath = normalizedPath.replace(/\.[^./\\]+$/, '');
      lines.push(`### [${normalizedPath}](./${linkPath}.md)`);
      lines.push('');
      lines.push(`- ${result.stats.functions} functions`);
      lines.push(`- ${result.stats.classes} classes`);
      lines.push(`- ${result.stats.exports} exports`);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Calculate overall statistics
   */
  calculateStats(allElements) {
    return {
      total: allElements.length,
      functions: allElements.filter(e => e.type === DOC_TYPES.FUNCTION).length,
      classes: allElements.filter(e => e.type === DOC_TYPES.CLASS).length,
      constants: allElements.filter(e => e.type === DOC_TYPES.CONSTANT).length,
      interfaces: allElements.filter(e => e.type === DOC_TYPES.INTERFACE).length,
      exported: allElements.filter(e => e.exported).length,
      documented: allElements.filter(e => e.description).length,
      undocumented: allElements.filter(e => !e.description && e.type === DOC_TYPES.FUNCTION).length,
    };
  }

  /**
   * Write documentation to files
   */
  async writeDocumentation(result, outputDir) {
    const dir = outputDir || this.outputDir;

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (result.results) {
      // Directory documentation
      const sourceDir = typeof result.sourceDir === 'string' ? result.sourceDir : null;
      for (const fileResult of result.results) {
        const relativePath = sourceDir
          ? path.relative(sourceDir, fileResult.filePath)
          : path.basename(fileResult.filePath, path.extname(fileResult.filePath));
        const safeRelativePath = relativePath && !relativePath.startsWith('..')
          ? relativePath
          : path.basename(fileResult.filePath, path.extname(fileResult.filePath));
        const fileName = safeRelativePath.replace(path.extname(safeRelativePath), '');
        const ext = this.format === 'html' ? 'html' : 'md';
        const outPath = path.join(dir, `${fileName}.${ext}`);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, fileResult.documentation);
      }

      // Write index
      const indexPath = path.join(dir, this.format === 'html' ? 'index.html' : 'README.md');
      fs.writeFileSync(indexPath, result.index);
    } else {
      // Single file documentation
      const fileName = path.basename(result.filePath, path.extname(result.filePath));
      const ext = this.format === 'html' ? 'html' : 'md';
      const outPath = path.join(dir, `${fileName}.${ext}`);
      fs.writeFileSync(outPath, result.documentation);
    }

    return { success: true, outputDir: dir };
  }
}

/**
 * Create generator instance
 */
function createDocGenerator(options = {}) {
  return new DocGenerator(options);
}

/**
 * Quick documentation generation
 */
async function generateDocs(target, options = {}) {
  const generator = createDocGenerator(options);

  if (fs.statSync(target).isDirectory()) {
    return generator.generateForDirectory(target, options);
  } else {
    return generator.generateForFile(target);
  }
}

module.exports = {
  DocGenerator,
  createDocGenerator,
  generateDocs,
  DOC_TYPES,
};
