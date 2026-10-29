/**
 * Schema inference.
 *
 * Given every observed sample of a value (multiple responses of the same
 * endpoint, multiple request bodies), produce a JSON Schema. Rules are
 * deliberately conservative: we would rather under-describe than invent a
 * constraint the server does not actually enforce.
 */

import { isObject, typeOf } from './util.ts';

export interface Schema {
  type?: string | string[];
  format?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: any[];
  nullable?: boolean;
  example?: any;
  description?: string;
}

const FORMATS: Array<[RegExp, string]> = [
  [/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/, 'date-time'],
  [/^\d{4}-\d{2}-\d{2}$/, 'date'],
  [/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/, 'email'],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'uuid'],
  [/^https?:\/\/\S+$/, 'uri'],
];

function stringSchema(values: string[]): Schema {
  const schema: Schema = { type: 'string' };

  // A format is only asserted when every sample agrees, so one odd value does
  // not mislabel the whole field.
  for (const [rx, format] of FORMATS) {
    if (values.every((v) => rx.test(v))) {
      schema.format = format;
      break;
    }
  }

  const distinct = [...new Set(values)];
  if (distinct.length > 1 && distinct.length <= 6 && values.length >= 4 && distinct.every((v) => v.length <= 24)) {
    schema.enum = distinct;
  }

  schema.example = values[0];
  return schema;
}

export function inferFromSamples(values: any[]): Schema {
  const defined = values.filter((v) => v !== undefined);
  const nullCount = defined.filter((v) => v === null).length;
  const values_ = defined.filter((v) => v !== null);

  if (!values_.length) return { nullable: true };
  const nullable = nullCount > 0;

  const types = new Set(values_.map((v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)));
  const only = types.size === 1 ? [...types][0] : null;

  if (only === 'object') {
    const objects = values_.filter(isObject);
    const counts = new Map<string, number>();
    for (const obj of objects) {
      for (const key of Object.keys(obj)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const properties: Record<string, Schema> = {};
    const required: string[] = [];
    for (const key of [...counts.keys()].sort()) {
      const present = objects.filter((o) => key in o).map((o) => o[key]);
      properties[key] = inferFromSamples(present);
      if ((counts.get(key) ?? 0) === objects.length && objects.length > 0) required.push(key);
    }
    const schema: Schema = { type: 'object', properties };
    if (required.length) schema.required = required;
    if (nullable) schema.nullable = true;
    return schema;
  }

  if (only === 'array') {
    const items = values_.flat();
    const schema: Schema = { type: 'array', items: items.length ? inferFromSamples(items) : {} };
    if (nullable) schema.nullable = true;
    return schema;
  }

  if (only === 'string') {
    const schema = stringSchema(values_.filter((v) => typeof v === 'string'));
    if (nullable) schema.nullable = true;
    return schema;
  }

  if (only === 'number') {
    const allInt = values_.every((v) => Number.isInteger(v));
    const schema: Schema = { type: allInt ? 'integer' : 'number', example: values_[0] };
    if (nullable) schema.nullable = true;
    return schema;
  }

  if (only === 'boolean') {
    const schema: Schema = { type: 'boolean', example: values_[0] };
    if (nullable) schema.nullable = true;
    return schema;
  }

  // Mixed types: keep every observed type, which is valid JSON Schema 2020-12.
  const schema: Schema = { type: [...types] };
  if (nullable && !types.has('null')) schema.nullable = true;
  return schema;
}

export function inferSingle(value: any): Schema {
  return inferFromSamples([value]);
}

/** Collect every value observed for a dotted path, e.g. `body.items[].price`. */
export function collect(samples: any[], pick: (sample: any) => any): any[] {
  return samples.map(pick).filter((v) => v !== undefined);
}

export function sampleSize(schema: Schema): number {
  return JSON.stringify(schema).length;
}

/** Strip `example` keys for comparison/dedupe purposes. */
export function structural(schema: any): any {
  if (Array.isArray(schema)) return schema.map(structural);
  if (isObject(schema)) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(schema)) {
      if (k === 'example') continue;
      out[k] = structural(v);
    }
    return out;
  }
  return schema;
}

export function schemaKind(value: any): string {
  const t = typeOf(value);
  if (t === 'object') return 'object';
  if (t === 'array') return 'array';
  return t;
}
