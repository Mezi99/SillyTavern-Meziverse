/**
 * The Connections tab: where each watcher agent's LLM calls ride.
 *
 * One engine, many doors. Every watcher agent - the Music DJ today, the
 * background and map watchers as they learn to ride one - picks its own
 * connection here and asks through the same `generateOn`: the connection
 * SillyTavern is talking through now, one of SillyTavern's own Connection
 * Manager profiles, or a custom OpenAI-compatible endpoint. The agent id is
 * the only thing that differs between watchers, so a new agent's section is
 * one line in `CONNECTION_AGENTS` and one `generateOn` call at its watcher -
 * never a second copy of this file's logic.
 *
 * Wire shapes (`connectionMessages`, `customEndpoint`, `customPayload`) are
 * pure: no DOM, no SillyTavern. Two rules ride every route: never a response
 * length cap (providers that count the prompt against the budget starve the
 * answer to nothing) and never structured output on the wire (some
 * connections reject it outright; answers are read from the text). The
 * section factory below is the only thing that renders.
 */

import { ctx, errorText, generateRaw } from './st.js';
import { connectionFor, setConnection } from './settings.js';

const LOG = '[Meziverse connections]';

/**
 * The agents that get a section on the tab. The background and map agents
 * join this list in their own batches - same component, same engine.
 */
export const CONNECTION_AGENTS = [
    {
        id: 'musicAgent',
        label: 'Music Agent',
    },
];

/* ---------- the wire shapes (pure) ---------- */

/**
 * One watcher request as wire messages: the system prompt on top, then the
 * prompt's own turns in their roles (a plain string rides as one user turn).
 *
 * @param {{systemPrompt?:string, prompt:string|Array<{role:string, content:string}>}} request
 * @returns {Array<{role:string, content:string}>}
 */
export function connectionMessages({ systemPrompt, prompt } = {}) {
    const messages = [];
    const system = String(systemPrompt ?? '').trim();
    if (system) messages.push({ role: 'system', content: system });

    const turns = Array.isArray(prompt)
        ? prompt
        : [{ role: 'user', content: String(prompt ?? '') }];
    for (const turn of turns) {
        const content = String(turn?.content ?? '').trim();
        if (!content) continue;
        const role = ['system', 'user', 'assistant'].includes(turn?.role) ? turn.role : 'user';
        messages.push({ role, content });
    }
    return messages;
}

/** The custom endpoint's base URL ('' when there is none a fetch could use). */
export function customEndpoint(url) {
    const base = String(url ?? '').trim().replace(/\/+$/, '');
    return /^https?:\/\//i.test(base) ? base : '';
}

/**
 * The custom endpoint's body. Deliberately no max_tokens and no
 * response_format: the answer length is the provider's to decide, and the
 * answer is read from the text whatever else comes with it.
 */
export function customPayload(connection, messages) {
    const payload = { messages };
    const model = String(connection?.customModel ?? '').trim();
    if (model) payload.model = model;
    return payload;
}

/* ---------- the router ---------- */

/**
 * One quiet watcher call, riding the agent's own connection. Same request in
 * (`{prompt, systemPrompt}`) and same answer out (`{ok, text, error}`) as
 * the plain call, so a watcher never learns where its LLM lives.
 *
 * @param {string} agentId the agent whose connection rides (see CONNECTION_AGENTS)
 * @param {{prompt:string|Array<{role:string, content:string}>, systemPrompt?:string}} request
 * @returns {Promise<{ok:boolean, text:string, error:string}>}
 */
export async function generateOn(agentId, request = {}) {
    const connection = connectionFor(agentId);
    if (connection.source === 'profile') return generateViaProfile(connection, request);
    if (connection.source === 'custom') return generateViaCustom(connection, request);
    return generateRaw(request);
}

/** A saved Connection Manager profile: its API, model and presets decide. */
async function generateViaProfile(connection, request) {
    if (!connection.profileId) {
        return { ok: false, text: '', error: 'No connection profile is chosen.' };
    }

    const service = ctx()?.ConnectionManagerRequestService;
    if (typeof service?.sendRequest !== 'function') {
        return { ok: false, text: '', error: 'SillyTavern\u2019s Connection Manager is not available.' };
    }

    try {
        // No max_tokens: the answer length is the provider's to decide (a
        // cap this request can afford starves the answer to nothing).
        const data = await service.sendRequest(
            connection.profileId,
            connectionMessages(request),
            undefined,
            { stream: false, extractData: true, includePreset: true, includeInstruct: true },
        );
        return { ok: true, text: String(data?.content ?? '').trim(), error: '' };
    } catch (error) {
        console.warn(`${LOG} the profile call failed`, error);
        return { ok: false, text: '', error: `The connection call failed: ${errorText(error)}` };
    }
}

/** A custom OpenAI-compatible endpoint: /chat/completions, answered in text. */
async function generateViaCustom(connection, request) {
    const base = customEndpoint(connection.customUrl);
    if (!base) {
        return { ok: false, text: '', error: 'The custom connection has no API URL.' };
    }

    try {
        const response = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(connection.customKey ? { Authorization: `Bearer ${connection.customKey}` } : {}),
            },
            body: JSON.stringify(customPayload(connection, connectionMessages(request))),
        });

        const raw = await response.text();
        if (!response.ok) {
            return {
                ok: false,
                text: '',
                error: `The custom API answered ${response.status}: ${raw.slice(0, 200) || response.statusText}`,
            };
        }

        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            return { ok: false, text: '', error: 'The custom API answered with something unreadable.' };
        }

        const content = data?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') {
            return { ok: false, text: '', error: 'The custom API answered without a message.' };
        }
        return { ok: true, text: content.trim(), error: '' };
    } catch (error) {
        console.warn(`${LOG} the custom call failed`, error);
        return { ok: false, text: '', error: `The custom call failed: ${errorText(error)}` };
    }
}

/* ---------- the section factory (the only thing that renders) ---------- */

const svg = name => `<svg class="ico" aria-hidden="true"><use href="#mz-i-${name}"/></svg>`;

/** One agent's expandable section - the same component for every agent. */
function connectionSection({ id, label }) {
    return `
        <div class="mz-set-group mz-set-group--fold" data-mz-pane="connections" data-mz-conn="${id}">
            <h3><button class="mz-set-head" type="button" aria-expanded="false" data-mz-section="conn-${id}">${label} ${svg('chevdown')}</button></h3>
            <div class="mz-set-row">
                <span class="mz-set-label"><b>Connection</b></span>
                <div class="mz-seg" role="group" aria-label="Connection source">
                    <button type="button" data-mz-conn-src="current">Current ST API</button>
                    <button type="button" data-mz-conn-src="profile">ST profile</button>
                    <button type="button" data-mz-conn-src="custom">Custom</button>
                </div>
            </div>
            <div class="mz-set-row" data-mz-conn-row="profile">
                <span class="mz-set-label"><b>Connection profile</b></span>
                <select class="mz-select" data-mz-conn-select aria-label="Connection profile"></select>
            </div>
            <div class="mz-set-row mz-set-row--prompt" data-mz-conn-row="custom-url">
                <span class="mz-set-label"><b>API URL</b></span>
                <input class="mz-select" type="text" data-mz-conn-field="customUrl" aria-label="API URL" placeholder="http://localhost:1234/v1" spellcheck="false">
            </div>
            <div class="mz-set-row mz-set-row--prompt" data-mz-conn-row="custom-key">
                <span class="mz-set-label"><b>API key</b><small>Saved in SillyTavern\u2019s extension settings.</small></span>
                <input class="mz-select" type="password" data-mz-conn-field="customKey" aria-label="API key" placeholder="sk-..." autocomplete="off">
            </div>
            <div class="mz-set-row mz-set-row--prompt" data-mz-conn-row="custom-model">
                <span class="mz-set-label"><b>Model</b></span>
                <input class="mz-select" type="text" data-mz-conn-field="customModel" aria-label="Model" placeholder="model name" spellcheck="false">
            </div>
            <div class="mz-set-row">
                <span class="mz-set-label"><b>Test</b></span>
                <div>
                    <button class="mz-btn-ghost" type="button" data-mz-conn-test>Send test call</button>
                    <span class="mz-conn-state" data-mz-conn-state></span>
                </div>
            </div>
        </div>`;
}

/** The profiles the select offers: Connection Manager's, best effort. */
function profileOptions(selected) {
    let profiles = [];
    let reason = '';
    try {
        profiles = ctx()?.ConnectionManagerRequestService?.getSupportedProfiles?.() ?? [];
    } catch (error) {
        reason = errorText(error);
    }

    const options = ['<option value="">- choose a profile -</option>'];
    for (const profile of profiles) {
        const what = [profile.api, profile.model].filter(Boolean).join(' \u00b7 ');
        options.push(`<option value="${escapeAttr(profile.id)}">${escapeAttr(profile.name)}${what ? ` (${escapeAttr(what)})` : ''}</option>`);
    }
    if (!profiles.length && reason) {
        options.push(`<option value="" disabled>Connection Manager unavailable: ${escapeAttr(reason)}</option>`);
    }

    const html = options.join('');
    return { html, known: profiles.some(profile => profile.id === selected) };
}

function escapeAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

/**
 * Mounts the Connections tab: one section per agent from the same factory,
 * wired through one small listener per section. Called once, with the
 * element the sections replace - the sheet is built once and never rebuilt.
 */
export function mountConnections(host) {
    if (!host) return;

    const holder = document.createElement('div');
    holder.innerHTML = CONNECTION_AGENTS.map(connectionSection).join('');
    const groups = Array.from(holder.children);
    host.replaceWith(...groups);

    for (const group of groups) {
        wireSection(group);
    }
}

function wireSection(group) {
    const id = group.dataset.mzConn;
    const one = name => group.querySelector(`[data-mz-conn-${name}]`);
    const rows = {
        profile: group.querySelector('[data-mz-conn-row="profile"]'),
        custom: ['custom-url', 'custom-key', 'custom-model'].map(name => group.querySelector(`[data-mz-conn-row="${name}"]`)),
    };
    const select = one('select');
    const state = one('state');

    const sync = () => {
        const connection = connectionFor(id);
        for (const button of group.querySelectorAll('[data-mz-conn-src]')) {
            const on = button.dataset.mzConnSrc === connection.source;
            button.classList.toggle('is-on', on);
            button.setAttribute('aria-pressed', String(on));
        }
        rows.profile.hidden = connection.source !== 'profile';
        for (const row of rows.custom) row.hidden = connection.source !== 'custom';

        const { html, known } = profileOptions(connection.profileId);
        if (select.innerHTML !== html) select.innerHTML = html;
        select.value = known ? connection.profileId : '';
        for (const field of group.querySelectorAll('[data-mz-conn-field]')) {
            field.value = connection[field.dataset.mzConnField] ?? '';
        }
    };

    group.addEventListener('click', async event => {
        const source = event.target.closest('[data-mz-conn-src]');
        if (source) {
            setConnection(id, { source: source.dataset.mzConnSrc });
            sync();
            return;
        }

        const test = event.target.closest('[data-mz-conn-test]');
        if (test) {
            test.disabled = true;
            state.textContent = 'Asking\u2026';
            state.classList.remove('is-bad');
            const result = await generateOn(id, {
                systemPrompt: 'You are a connection test. Answer with exactly one word.',
                prompt: 'Answer with the word: pong',
            });
            state.textContent = result.ok
                ? `Answered: ${result.text.slice(0, 40) || '(nothing)'}`
                : result.error;
            state.classList.toggle('is-bad', !result.ok);
            test.disabled = false;
        }
    });

    select.addEventListener('change', () => {
        setConnection(id, { profileId: select.value });
    });

    for (const field of group.querySelectorAll('[data-mz-conn-field]')) {
        field.addEventListener('change', () => {
            setConnection(id, { [field.dataset.mzConnField]: field.value.trim() });
        });
    }

    sync();
}
