/**
 * Minimal YAML writer. Strings are always double quoted, which removes every
 * ambiguity about colons, hashes, leading dashes and reserved words.
 */

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function scalar(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return quote(String(value));
}

function isEmpty(value: any): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function emit(value: any, indent: number): string {
  const pad = '  '.repeat(indent);

  if (Array.isArray(value)) {
    if (!value.length) return `${pad}[]`;
    return value
      .map((item) => {
        if (item && typeof item === 'object' && !isEmpty(item)) {
          const nested = emit(item, indent + 1);
          const innerPad = '  '.repeat(indent + 1);
          const [first, ...rest] = nested.split('\n');
          return [`${pad}- ${first.slice(innerPad.length)}`, ...rest].join('\n');
        }
        return `${pad}- ${scalar(item)}`;
      })
      .join('\n');
  }

  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return `${pad}{}`;
    return keys
      .map((key) => {
        const child = value[key];
        const head = `${pad}${quote(key)}:`;
        if (child && typeof child === 'object') {
          if (isEmpty(child)) return `${head} ${Array.isArray(child) ? '[]' : '{}'}`;
          return `${head}\n${emit(child, indent + 1)}`;
        }
        return `${head} ${scalar(child)}`;
      })
      .join('\n');
  }

  return `${pad}${scalar(value)}`;
}

export function toYaml(value: any): string {
  return `${emit(value, 0)}\n`;
}
