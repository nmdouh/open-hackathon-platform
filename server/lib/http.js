'use strict';

const { z } = require('zod');
const { badRequest } = require('./errors');

// Validates input with a zod schema and returns the parsed value, or throws a
// 400 listing each failing field.
function parse(schema, input) {
  const result = schema.safeParse(input === undefined ? {} : input);
  if (result.success) return result.data;
  const fields = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw badRequest('VALIDATION_FAILED', 'Invalid input', fields);
}

const uuid = z.string().uuid();
const text = (max) => z.string().trim().max(max);
const requiredText = (max) => z.string().trim().min(1).max(max);
const isoDate = z.string().datetime({ offset: true }).nullable();

function idParam(req, name = 'id') {
  return parse(uuid, req.params[name]);
}

module.exports = { z, parse, uuid, text, requiredText, isoDate, idParam };
