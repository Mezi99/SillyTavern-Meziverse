import test from 'node:test';
import assert from 'node:assert/strict';

import { connectionMessages, customEndpoint, customPayload } from '../src/connections.js';
import { normalizeConnection } from '../src/settings.js';

test('connectionMessages puts the system prompt on top and a string prompt below', () => {
    const messages = connectionMessages({ systemPrompt: 'You are a watcher.', prompt: 'Where is the story?' });
    assert.deepEqual(messages, [
        { role: 'system', content: 'You are a watcher.' },
        { role: 'user', content: 'Where is the story?' },
    ]);
});

test('connectionMessages keeps the prompt turns in their own roles and drops empty ones', () => {
    const messages = connectionMessages({
        systemPrompt: '   ',
        prompt: [
            { role: 'user', content: 'the pier at dawn' },
            { role: 'assistant', content: 'the warehouse at midnight' },
            { role: 'user', content: '   ' },
            { role: 'narrator', content: 'pick the music' },
        ],
    });
    assert.deepEqual(messages, [
        { role: 'user', content: 'the pier at dawn' },
        { role: 'assistant', content: 'the warehouse at midnight' },
        { role: 'user', content: 'pick the music' },
    ]);
});

test('customEndpoint only trusts an http(s) base and sheds trailing slashes', () => {
    assert.equal(customEndpoint('http://localhost:1234/v1/'), 'http://localhost:1234/v1');
    assert.equal(customEndpoint('  https://api.example.com/v1///  '), 'https://api.example.com/v1');
    assert.equal(customEndpoint('ftp://somewhere'), '');
    assert.equal(customEndpoint('localhost:1234'), '');
    assert.equal(customEndpoint(''), '');
});

test('customPayload carries the model when there is one and never a cap or a format', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const withModel = customPayload({ customModel: ' qwen3 ' }, messages);
    assert.equal(withModel.model, 'qwen3');
    assert.deepEqual(withModel.messages, messages);
    assert.equal('max_tokens' in withModel, false, 'no cap: providers that count the prompt starve the answer');
    assert.equal('response_format' in withModel, false, 'never structured output on the wire');

    const bare = customPayload({ customModel: '' }, messages);
    assert.equal('model' in bare, false, 'an empty model is no model');
});

test('normalizeConnection fills every field and only trusts its three sources', () => {
    assert.deepEqual(normalizeConnection(undefined), {
        source: 'current',
        profileId: '',
        customUrl: '',
        customKey: '',
        customModel: '',
    });

    assert.deepEqual(normalizeConnection({ source: 'custom', customUrl: 'http://x', customKey: 42, extra: 'gone' }), {
        source: 'custom',
        profileId: '',
        customUrl: 'http://x',
        customKey: '',
        customModel: '',
    });

    assert.equal(normalizeConnection({ source: 'made-up' }).source, 'current');
    assert.equal(normalizeConnection({ source: 'profile', profileId: 'p1' }).profileId, 'p1');
});
