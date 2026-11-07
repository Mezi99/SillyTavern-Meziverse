import test from 'node:test';
import assert from 'node:assert/strict';

import { splitStory } from '../src/history.js';

const clean = text => text;
const msg = (mes, is_user = false) => ({ mes, is_user });

test('the story is the chat\'s own turns - tags and scaffolding survive', async () => {
    const tagged = '<scene location="The Docks" /> The rain eases. <statusblock><details><summary>Stats</summary>STR 12</details></statusblock>';
    const { history, last } = await splitStory([
        msg('Old news.'),
        msg('You answer me.', true),
        msg(tagged),
    ], { turns: 2, clean });

    assert.deepEqual(history.map(turn => [turn.role, turn.text]), [
        ['assistant', 'Old news.'],
        ['user', 'You answer me.'],
    ]);
    assert.equal(last.role, 'assistant');
    assert.equal(last.text, tagged.trim(), 'nothing is stripped - the user\'s regexes alone decide what goes');
});

test('the turn to judge is the latest AI reply, whole and apart', async () => {
    const { history, last } = await splitStory([
        msg('one'),
        msg('two', true),
        msg('three'),
    ], { turns: 1, clean });

    assert.equal(last.text, 'three');
    assert.deepEqual(history.map(turn => turn.text), ['two'], 'the history is the turn before it, whatever its side');
});

test('`at` names the turn to judge - a watcher resolves its own reply', async () => {
    const messages = [msg('first'), msg('second'), msg('third')];
    const { history, last } = await splitStory(messages, { turns: 1, clean, at: 1 });

    assert.equal(last.text, 'second');
    assert.deepEqual(history.map(turn => turn.text), ['first']);
});

test('whole turns drop from the oldest end when the story outgrows its budget', async () => {
    const big = size => 'x'.repeat(size);
    const { history, last } = await splitStory([
        msg(big(300)),
        msg(big(300)),
        msg(big(300)),
    ], { turns: 3, clean, budget: 700 });

    assert.equal(last.text, big(300), 'the judged turn stays whole');
    assert.equal(history.length, 1, 'only the newest history turn fits the budget');
    assert.equal(history[0].text, big(300));
});

test('the judged turn is never dropped, whatever its size', async () => {
    const { history, last } = await splitStory([
        msg('small history'),
        msg('y'.repeat(5000)),
    ], { turns: 1, clean, budget: 500 });

    assert.equal(last.text, 'y'.repeat(5000));
    assert.deepEqual(history, [], 'the history bows out first');
});

test('the cleaner sees each turn with its side and depth from the end', async () => {
    const seen = [];
    const spy = (text, who) => { seen.push({ text, ...who }); return text; };

    await splitStory([msg('a'), msg('b', true), msg('c')], { turns: 2, clean: spy });

    assert.deepEqual(seen, [
        { text: 'a', isUser: false, depth: 2 },
        { text: 'b', isUser: true, depth: 1 },
        { text: 'c', isUser: false, depth: 0 },
    ]);
});

test('a blank judged turn bows to the newest real one', async () => {
    const { history, last } = await splitStory([msg('real words'), msg('   ')], { turns: 1, clean });

    assert.equal(last.text, 'real words');
    assert.deepEqual(history, []);
});

test('an empty chat judges nothing', async () => {
    const { history, last } = await splitStory([], { clean });
    assert.deepEqual(history, []);
    assert.equal(last, null);
});

test('without a working regex seam the text still goes raw', async () => {
    // The default cleaner is SillyTavern's prompt-regex pass; outside the
    // app it simply has nothing to work with and must not eat a byte.
    const { last } = await splitStory([msg('<music>play something</music> Midnight Drive')]);
    assert.equal(last.text, '<music>play something</music> Midnight Drive');
});
