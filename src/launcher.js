/**
 * The two ways into Meziverse: the wand menu and the Extensions panel.
 *
 * Both use SillyTavern's own classes so they look like every other extension,
 * and both call the same open().
 */

const MENU_ID = 'mz-launcher';
const DRAWER_ID = 'mz-drawer';

/** Adds "Meziverse" to the wand menu. */
export function addLauncher(onOpen) {
    if (document.getElementById(MENU_ID)) return;

    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;

    const item = document.createElement('div');
    item.id = MENU_ID;
    item.className = 'list-group-item flex-container flexGap5';
    item.innerHTML = '<div class="fa-solid fa-masks-theater extensionsMenuExtensionButton"></div><span>Meziverse</span>';
    item.addEventListener('click', onOpen);
    menu.appendChild(item);
}

/** Adds Meziverse's block to the Extensions panel's left column. */
export function addDrawerBlock(onOpen) {
    if (document.getElementById(DRAWER_ID)) return;

    const host = document.getElementById('extensions_settings') ?? document.getElementById('extensions_settings2');
    if (!host) return;

    const box = document.createElement('div');
    box.id = DRAWER_ID;
    box.className = 'extension_container';
    box.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Meziverse</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="flex-container flexGap5" style="margin:6px 0">
                <div id="mz-drawer-open" class="menu_button menu_button_icon">
                    <i class="fa-solid fa-masks-theater"></i><span>Open Meziverse</span>
                </div>
            </div>
            <small>A fullscreen scene for the open chat. Everything Meziverse shows comes from that chat; nothing is stored anywhere else.</small>
        </div>
    </div>`;

    host.appendChild(box);
    box.querySelector('#mz-drawer-open')?.addEventListener('click', onOpen);
}
