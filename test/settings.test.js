import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_BG_PROMPT_OFF,
    DEFAULT_BG_PROMPT_ON,
    DEFAULT_BG_TRANSPORT_PROMPT,
    PRE_PROSE_DEFAULT_BG_PROMPT_OFF,
    PRE_PROSE_DEFAULT_BG_PROMPT_ON,
    PRE_PROSE_DEFAULT_BG_TRANSPORT_PROMPT,
} from '../src/backgrounds.js';
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

test('untouched background defaults follow the prose-first refresh; edits stay theirs', () => {
    withStore({
        bgPromptOn: PRE_PROSE_DEFAULT_BG_PROMPT_ON,
        bgPromptOff: PRE_PROSE_DEFAULT_BG_PROMPT_OFF,
        bgPromptTransport: PRE_PROSE_DEFAULT_BG_TRANSPORT_PROMPT,
        bgStyle: 'anime style, visual novel background art, detailed environment, cinematic lighting',
    }, meziverse => {
        assert.equal(settings().bgPromptOn, DEFAULT_BG_PROMPT_ON);
        assert.equal(settings().bgPromptOff, DEFAULT_BG_PROMPT_OFF);
        assert.equal(settings().bgPromptTransport, DEFAULT_BG_TRANSPORT_PROMPT);
        assert.equal(settings().bgStyle, 'Anime visual novel background art, soft cinematic lighting');
        assert.equal(meziverse.bgPromptOn, DEFAULT_BG_PROMPT_ON, 'the migration rewrites the store, not just the read');
    });

    withStore({ bgPromptOn: 'My own rules.', bgStyle: 'my own style' }, meziverse => {
        assert.equal(settings().bgPromptOn, 'My own rules.');
        assert.equal(settings().bgStyle, 'my own style');
        assert.equal(meziverse.bgPromptOn, 'My own rules.');
    });

    withStore({}, () => {
        assert.ok(settings().bgNegative.includes('silhouette'), 'the default negative also rules out figures');
        assert.ok(settings().bgNegative.includes('figure'));
    });
});
