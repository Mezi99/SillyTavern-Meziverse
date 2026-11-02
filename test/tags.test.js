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

test('speech keeps its words; a flashback keeps nothing but its pill', () => {
    assert.equal(stripTags('<speech character="Mara" tone="dry">Hello</speech> there'), 'Hello there');
    assert.equal(stripTags('<flashback character="Ilya" when="1999">Before.</flashback>'), '');
    assert.equal(stripTags('now <flashback character="Ilya">Before.</flashback> then'), 'now  then');
});

test('a flashback becomes a mark and keeps its body for the mindscape', () => {
    const cues = splitCues('She left.<flashback character="Mara" when="Age 10" trigger="the lamp">"Run," she said.</flashback> After.');

    assert.deepEqual(cues.map(cue => cue.type), ['text', 'mark', 'text']);
    assert.equal(cues[1].tag.name, 'flashback');
    assert.equal(cues[1].tag.attrs.when, 'Age 10');
    assert.equal(cues[1].tag.body, '"Run," she said.');
    assert.equal(cues[0].text, 'She left.');
    assert.equal(cues[2].text, ' After.');
});

test('an unclosed flashback draws nothing and hides its tail', () => {
    const cues = splitCues('one <flashback character="Ma');

    assert.deepEqual(cues, [{ type: 'text', text: 'one ' }]);
});

test('inline self-closing tags vanish without a trace', () => {
    const mes = 'Before <meanwhile event="something" />after <filter reason="x" />the end';
    assert.equal(stripTags(mes), 'Before after the end');
});

test('a meanwhile becomes a box at the point it appeared', () => {
    const cues = splitCues('Before <meanwhile event="the ferry leaves" importance="they miss the tide" />after');

    assert.deepEqual(cues.map(cue => cue.type), ['text', 'box', 'text']);
    assert.equal(cues[0].text, 'Before ');
    assert.equal(cues[1].tag.name, 'meanwhile');
    assert.equal(cues[1].tag.attrs.event, 'the ferry leaves');
    assert.equal(cues[1].tag.attrs.importance, 'they miss the tide');
    assert.equal(cues[2].text, 'after');
});

test('a box cuts the prose like a scene row', () => {
    const cues = splitCues('a<meanwhile event="one" />b<scene date="Day 1" />c');

    assert.deepEqual(cues.map(cue => cue.type), ['text', 'box', 'text', 'scene', 'text']);
});

test('meanwhile boxes stack in reading order', () => {
    const cues = splitCues('intro<meanwhile event="one" /><meanwhile event="two" />outro');

    assert.deepEqual(cues.map(cue => cue.type), ['text', 'box', 'box', 'text']);
    assert.deepEqual(cues.filter(cue => cue.type === 'box').map(cue => cue.tag.attrs.event), ['one', 'two']);
});

test('a mark stays on its own side of a box', () => {
    const cues = splitCues('a<lie type="omitting" /><meanwhile event="x" />b');

    assert.deepEqual(cues.map(cue => cue.type), ['text', 'mark', 'box', 'text']);
});

test('an unclosed meanwhile draws nothing and hides its tail', () => {
    const cues = splitCues('one <meanwhile event="some');

    assert.deepEqual(cues, [{ type: 'text', text: 'one ' }]);
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

test('a mark leaves its tag whole and sits where the tag stood', () => {
    const cues = splitCues('She smiled. <lie character="Mara" type="deceiving" truth="she knew" reason="fear" />Then he left.');

    assert.deepEqual(cues.map(cue => cue.type), ['text', 'mark', 'text']);
    assert.equal(cues[0].text, 'She smiled. ');
    assert.deepEqual(cues[1].tag.attrs, {
        character: 'Mara',
        type: 'deceiving',
        truth: 'she knew',
        reason: 'fear',
    });
    assert.equal(cues[2].text, 'Then he left.');
});

test('a mark on a line of its own joins the end of the previous paragraph', () => {
    const cues = splitCues('She smiled.\n<lie character="Mara" />Then he left.');

    assert.deepEqual(cues.map(cue => cue.type), ['text', 'mark', 'text']);
    assert.equal(cues[0].text, 'She smiled.');
    assert.equal(cues[2].text, '\nThen he left.');
});

test('marks stack at the paragraph end in reading order', () => {
    const cues = splitCues('She smiled.\n<lie character="Mara" />\n<filter reason="behind him" />Then he left.');

    assert.deepEqual(cues.map(cue => cue.type), ['text', 'mark', 'mark', 'text']);
    assert.equal(cues[0].text, 'She smiled.');
    assert.equal(cues[3].text, '\n\nThen he left.');
});

test('a mark at the very start of the message stays where it is', () => {
    const cues = splitCues('<filter event="steps" reason="behind him" />Nothing before.');

    assert.deepEqual(cues.map(cue => cue.type), ['mark', 'text']);
    assert.equal(cues[1].text, 'Nothing before.');
});

test('marks split the prose around them and scenes still cut runs', () => {
    const cues = splitCues('a<lie type="omitting" />b<scene date="Day 1" />c');

    assert.deepEqual(cues.map(cue => cue.type), ['text', 'mark', 'text', 'scene', 'text']);
    assert.equal(cues[0].text, 'a');
    assert.equal(cues[2].text, 'b');
    assert.equal(cues[4].text, 'c');
});

test('an unclosed mark draws nothing and hides its tail', () => {
    const cues = splitCues('one <lie character="Ma');

    assert.deepEqual(cues, [{ type: 'text', text: 'one ' }]);
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
