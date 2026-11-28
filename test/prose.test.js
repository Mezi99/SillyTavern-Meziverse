import test from 'node:test';
import assert from 'node:assert/strict';

import { reasoningOf, speechHtml, thoughtLabel, weatherGlyph } from '../src/prose.js';
import { faceVars } from '../src/imageprep.js';
import { parseTags } from '../src/tags.js';

const tag = mes => parseTags(mes)[0];

/** Runs `fn` with a SillyTavern stub wearing the given dialogue-face setting. */
function withFaces(dialogueFaces, fn) {
    const store = { extensionSettings: { meziverse: { avatars: true, dialogueFaces } } };
    globalThis.SillyTavern = { getContext: () => store };
    try {
        return fn();
    } finally {
        delete globalThis.SillyTavern;
    }
}

test('speechHtml wears the band layout the setting picks', () => {
    const line = '<speech character="Mara" tone="dry">"Anchor\'s out"</speech>';
    const sides = new Map([['mara', 'is-r']]);

    withFaces('immersiveA', () => {
        const out = speechHtml(tag(line), { message: { mes: line }, index: 0, sides });
        assert.equal(out.kind, 'band');
        assert.ok(out.html.includes('mz-band--hug'), 'A hugs its words');
        assert.ok(!out.html.includes('mz-band--centred'), 'and wears the other shape never');
        assert.ok(out.html.includes('is-r'), 'the speaker\'s side still rides');
    });

    withFaces('immersiveB', () => {
        const out = speechHtml(tag(line), { message: { mes: line }, index: 0, sides });
        assert.equal(out.kind, 'band');
        assert.ok(out.html.includes('mz-band--centred'), 'B is the one centred measure');
        assert.ok(!out.html.includes('mz-band--hug'));
    });

    for (const mode of ['simple', 'off']) {
        withFaces(mode, () => {
            const out = speechHtml(tag(line), { message: { mes: line }, index: 0, sides });
            assert.equal(out.kind, 'bubble', `${mode} keeps the bubble`);
            assert.ok(!out.html.includes('mz-band'), `${mode} never grows a band`);
        });
    }
});

test('a band with no picture keeps its furniture in both layouts', () => {
    const line = '<speech character="Nobody">"hi"</speech>';
    for (const [mode, shape] of [['immersiveA', 'mz-band--hug'], ['immersiveB', 'mz-band--centred']]) {
        withFaces(mode, () => {
            const out = speechHtml(tag(line), { message: { mes: line }, index: 0, sides: new Map() });
            assert.equal(out.kind, 'band');
            assert.ok(out.html.includes('is-empty'), 'a text-only band');
            assert.ok(out.html.includes(shape), `the ${mode} shape applies without art too`);
        });
    }
});

test('faceVars wears the frame - default and custom', () => {
    assert.equal(faceVars(), '--fx:0.5;--fy:0.27;--fs:2.9');
    assert.equal(faceVars({ fx: 0.42, fy: 0.31, fs: 2.2 }), '--fx:0.42;--fy:0.31;--fs:2.2');
    assert.equal(faceVars({}), '--fx:0.5;--fy:0.27;--fs:2.9');
});

test('reasoningOf reads the reasoning where SillyTavern keeps it', () => {
    assert.equal(reasoningOf({ extra: { reasoning: ' from the field ' } }), 'from the field');
    assert.equal(reasoningOf({ extra: { reasoning: 'raw', reasoning_display_text: ' shown ' } }), 'shown', 'the display twin wins, like in ST');
    assert.equal(reasoningOf({ extra: { reasoning: '' } }), '');
    assert.equal(reasoningOf(null), '');
    assert.equal(reasoningOf({}), '');
});

test('reasoningOf falls back to the variant, then to the in-band body', () => {
    const swiped = {
        extra: {},
        swipe_id: 1,
        swipes: ['one', 'two'],
        swipe_info: [{ extra: { reasoning: 'variant zero' } }, { extra: { reasoning: 'variant one' } }],
    };
    assert.equal(reasoningOf(swiped), 'variant one');

    assert.equal(
        reasoningOf({ extra: {}, mes: `${String.fromCharCode(60)}think${String.fromCharCode(62)}inline thinking${String.fromCharCode(60)}/think${String.fromCharCode(62)}prose` }),
        'inline thinking',
        'a thinking block stays readable when ST never moved it',
    );
});

test('thoughtLabel words the head like SillyTavern', () => {
    assert.equal(thoughtLabel({ extra: { reasoning_duration: 5000 } }), 'Thought for 5 seconds');
    assert.equal(thoughtLabel({ extra: { reasoning_duration: 90000 } }), 'Thought for 2 minutes');
    assert.equal(thoughtLabel({}, true), 'Thinking…');
    assert.equal(thoughtLabel({}), 'Reasoning');
});

test('weatherGlyph follows the weatherTag alone and reads Clear by the clock', () => {
    assert.equal(weatherGlyph(''), '', 'no tag, no glyph - the free text is never read');
    assert.equal(weatherGlyph('sandstorm', 12), '', 'unknown states fall back to nothing');

    const sun = weatherGlyph('sunny', 12);
    assert.ok(sun.includes('viewBox="0 0 24 24"'), 'the stroke set rides a 24x24 grid');
    assert.equal(weatherGlyph('Sunny', 23), sun, 'the tag is case-tolerant');

    assert.equal(weatherGlyph('clear', 12), sun, 'a clear day reads as the sun');
    assert.notEqual(weatherGlyph('clear', 23), sun, 'a clear night reads as the crescent');
    assert.notEqual(weatherGlyph('rain', 12), weatherGlyph('storm', 12));
});
