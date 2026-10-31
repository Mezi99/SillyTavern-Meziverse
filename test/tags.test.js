import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMessage, parseTags, scenesOf, splitCues, stripTags } from '../src/tags.js';

const scene = attrs => `<scene ${attrs} />`;

test('reads attributes in any order and either quote style', () => {
    const [tag] = parseTags(`<scene location="The Docks" date='9:40 PM' present="Mara, Ilya" weather="Rain" />`);

    assert.deepEqual(tag.attrs, {
        location: 'The Docks',
        date: '9:40 PM',
        present: 'Mara, Ilya',
        weather: 'Rain',
    });
    assert.equal(tag.name, 'scene');
    assert.equal(tag.selfClosing, true);
    assert.equal(tag.closed, true);
    assert.equal(tag.body, null);
});

test('a scene closes on > even without the slash', () => {
    const [tag] = parseTags('<scene date="Day 1">');

    assert.equal(tag.closed, true);
    assert.equal(tag.selfClosing, true);
    assert.equal(tag.attrs.date, 'Day 1');
});

test('a > inside a quoted value does not close the tag', () => {
    const [tag] = parseTags(`<scene location="Pier > 9" present="Mara's crew" />`);

    assert.equal(tag.attrs.location, 'Pier > 9');
    assert.equal(tag.attrs.present, "Mara's crew");
});

test('apostrophes, pipes and colons stay in the value', () => {
    const [tag] = parseTags(scene(`date="Tuesday, 9:40 PM" location="Old Town | Pier 9" present="Ilya d'Arcy, Wren"`));

    assert.equal(tag.attrs.date, 'Tuesday, 9:40 PM');
    assert.equal(tag.attrs.location, 'Old Town | Pier 9');
    assert.equal(tag.attrs.present, "Ilya d'Arcy, Wren");
});

test('names are matched case-insensitively', () => {
    const tags = parseTags('<SCENE DATE="Day 1" />');

    assert.equal(tags.length, 1);
    assert.equal(tags[0].name, 'scene');
    assert.equal(tags[0].attrs.date, 'Day 1');
});

test('every complete scene is returned, in order, with no collapsing', () => {
    const tags = parseTags('one <scene date="Day 1" /> two <scene date="Day 2" /> three');

    assert.deepEqual(scenesOf(tags).map(tag => tag.attrs.date), ['Day 1', 'Day 2']);
});

test('unknown HTML is not a tag', () => {
    assert.deepEqual(parseTags('<div class="x"><b>A</b></div>'), []);
    assert.equal(stripTags('<div class="x">A<br>B</div>'), '<div class="x">A<br>B</div>');
});

test('hidden blocks go, body and all', () => {
    const mes = 'a<think>secret <b>thoughts</b></think>b<LEDGER><recap era="x" fact="y" /></LEDGER>c';
    assert.equal(stripTags(mes), 'abc');
});

test('speech and flashback keep their words', () => {
    assert.equal(stripTags('<speech character="Mara" tone="dry">Hello</speech> there'), 'Hello there');
    assert.equal(stripTags('<flashback character="Ilya" when="1999">Before.</flashback>'), 'Before.');
});

test('inline self-closing tags vanish without a trace', () => {
    const mes = 'Before <meanwhile event="something" />after <filter reason="x" />the end';
    assert.equal(stripTags(mes), 'Before after the end');
});

test('an unclosed hidden tag hides its streaming tail', () => {
    assert.equal(stripTags('one<think>still thinking'), 'one');
    assert.equal(stripTags('one<LEDGER><recap era="x"'), 'one');
});

test('an unclosed scene hides the tail too', () => {
    assert.equal(stripTags('one<scene date="Day'), 'one');
});

test('an unclosed speech keeps its partial prose', () => {
    assert.equal(stripTags('one<speech character="Mara">hello'), 'onehello');
});

test('tags inside fenced or inline code are not tags', () => {
    assert.deepEqual(parseTags('```html\n<scene date="Day 1" />\n```'), []);
    assert.deepEqual(parseTags('Use `<scene date="Day 1" />` here'), []);
    assert.equal(parseTags('a `not <think>` b <scene date="Day 1" />').length, 1);

    const mixed = parseTags('```\n<scene date="Day 1" />\n```\n<scene date="Day 2" />');
    assert.deepEqual(mixed.map(tag => tag.attrs.date), ['Day 2']);
});

test('splitCues interleaves prose and complete scenes', () => {
    const cues = splitCues('intro<scene date="Day 1" />body');

    assert.deepEqual(cues.map(cue => cue.type), ['text', 'scene', 'text']);
    assert.equal(cues[0].text, 'intro');
    assert.equal(cues[1].tag.attrs.date, 'Day 1');
    assert.equal(cues[2].text, 'body');
});

test('splitCues folds hidden blocks out of the prose', () => {
    const cues = splitCues('a<think>secret</think>b');

    assert.deepEqual(cues, [{ type: 'text', text: 'ab' }]);
});

test('parseMessage caches on identity and rereads when mes changes', () => {
    const message = { mes: '<scene date="Day 1" />' };

    const first = parseMessage(message);
    assert.equal(parseMessage(message), first);
    assert.equal(first.tags.length, 1);

    message.mes = '<scene date="Day 2" />';
    const second = parseMessage(message);
    assert.notEqual(second, first);
    assert.equal(second.tags[0].attrs.date, 'Day 2');
});

test('parseMessage tolerates missing or non-object messages', () => {
    assert.deepEqual(parseMessage(null), { mes: '', tags: [] });
    assert.deepEqual(parseMessage({}), { mes: '', tags: [] });
});
