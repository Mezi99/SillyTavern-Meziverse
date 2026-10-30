/**
 * Meziverse — entry point.
 *
 * SillyTavern loads this file as a module after the page has booted. All we do
 * here is wait until the extension slots exist, add the two ways in, and mount
 * the (hidden) root the scene lives in.
 */

import { whenReady } from './src/st.js';
import { mount, open } from './src/overlay.js';
import { addLauncher, addDrawerBlock } from './src/launcher.js';

async function boot() {
    await whenReady();

    mount();
    addLauncher(open);
    addDrawerBlock(open);

    console.info('[Meziverse] ready');
}

boot();
