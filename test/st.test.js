import test from 'node:test';
import assert from 'node:assert/strict';

import { errorText } from '../src/st.js';

test('errorText never shows [object Object]', () => {
    assert.equal(errorText('plain failure'), 'plain failure');
    assert.equal(errorText(new Error('boom')), 'boom');
    assert.equal(errorText({ code: 503 }), '{"code":503}');
    assert.equal(errorText(null), 'unknown failure');
    assert.equal(errorText(Object.create(null)), 'unexpected failure');
});
