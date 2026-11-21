import test from 'node:test';
import assert from 'node:assert/strict';

import { dialogueFaceMode, settings } from '../src/settings.js';

/** Runs `fn` with a SillyTavern stub carrying the given meziverse settings. */
function withStore(meziverse, fn) {
    const store = { extensionSettings: { meziverse: { ...meziverse } } };
    globalThis.SillyTavern = { getContext: () => store };
    try {
        return fn(store.extensionSettings.meziverse);
    } finally {
        delete globalThis.SillyTavern;
    }
}

test('dialogueFaceMode wears all four wardrobes', () => {
    for (const mode of ['off', 'simple', 'immersiveA', 'immersiveB']) {
        withStore({ avatars: true, dialogueFaces: mode }, () => {
            assert.equal(dialogueFaceMode(), mode);
        });
    }
});

test('a stored immersive migrates to immersiveA, on the read and on the store', () => {
    withStore({ avatars: true, dialogueFaces: 'immersive' }, meziverse => {
        assert.equal(dialogueFaceMode(), 'immersiveA', 'the read lands on the closest layout');
        assert.equal(meziverse.dialogueFaces, 'immersiveA', 'the store is rewritten for good');
        assert.equal(settings().dialogueFaces, 'immersiveA', 'and what settings hands back agrees');
    });
});

test('an unknown wardrobe falls back to simple; avatars off says off whatever it wears', () => {
    withStore({ avatars: true, dialogueFaces: 'cinematic' }, () => {
        assert.equal(dialogueFaceMode(), 'simple');
    });
    withStore({ avatars: false, dialogueFaces: 'immersiveB' }, () => {
        assert.equal(dialogueFaceMode(), 'off');
    });
});
