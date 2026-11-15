// Looks (Process > Looks in the right sidebar) (the file format and rules are in core/looks.js): save the open photo's look, import a look file, put a look on the open photo, save one as a
// file to share, rename and delete. They are kept in the library (library/library.js).

import { makeLook, parseLook, applyLookToEdits, describeLook, lookFileName } from '../core/looks.js';

export function initLooks({ $, state, showMenu, editName, confirmInMenu, currentEdits, flushSave, applyEdits, scheduleSave, showNotice, showError, download }) {
  const hasPhoto = () => !!(state.info && state.current);

  // The looks are a dropdown (choosing one puts it on the open photo); the ••• button beside it acts on the look shown.
  let shown = '';
  function render() {
    const row = $('look-row');
    const looks = state.lib ? state.lib.looks : [];
    $('look-save').disabled = !hasPhoto();
    if (!looks.some((l) => l.id === shown)) shown = '';
    const select = Object.assign(document.createElement('select'), { title: 'Choose a look to put on the open photo' });
    select.setAttribute('aria-label', 'Look');
    select.append(new Option(looks.length ? 'Choose a look…' : 'No looks yet', ''));
    for (const entry of looks) select.append(new Option(entry.name, entry.id));
    select.value = shown;
    select.disabled = !looks.length;
    select.onchange = () => {
      shown = select.value;
      more.disabled = !shown;
      if (shown) apply(shown);
    };
    const more = Object.assign(document.createElement('button'), { type: 'button', className: 'more', textContent: '•••', title: 'Apply, save as a file, rename, delete the look shown', disabled: !shown });
    more.setAttribute('aria-label', 'Actions for the look shown');
    more.setAttribute('aria-haspopup', 'menu');
    more.onclick = () => menu(shown, row, more);
    row.replaceChildren(select, more);
  }

  // Puts a look on the open photo: its settings over the photo's, as one undo step, saved like any change.
  async function apply(id) {
    try {
      if (!hasPhoto()) {
        showNotice('Open a photo first', 'A look is put on the photo that is open.');
        return;
      }
      const photoBefore = state.current;
      const look = await state.lib.loadLook(id);
      if (!look) throw new Error('This look could not be read');
      // The photo may have been closed, or another opened, while the look loaded.
      if (!hasPhoto() || state.current !== photoBefore) {
        showNotice('The photo changed', 'Choose the look again to put it on the photo that is open.');
        return;
      }
      await flushSave();
      if (!hasPhoto() || state.current !== photoBefore) return;
      await applyEdits(state.info, applyLookToEdits(currentEdits(), look));
      scheduleSave();
    } catch (err) {
      showError(err);
    }
  }

  async function exportFile(id) {
    try {
      const look = await state.lib.loadLook(id);
      if (!look) throw new Error('This look could not be read');
      await download(new Blob([JSON.stringify(look, null, 2)], { type: 'application/json' }), lookFileName(look.name));
    } catch (err) {
      showError(err);
    }
  }

  function menu(id, row, button) {
    const entry = state.lib.look(id);
    if (!entry) return;
    showMenu(button, [
      { label: 'Apply to the open photo', action: () => apply(id) },
      { label: 'Save as a file…', action: () => exportFile(id) },
      {
        label: 'Rename…',
        action: () => editName(row, entry.name, async (name) => {
          if (name) await state.lib.renameLook(id, name);
          render();
        }, 'Look name'),
      },
      {
        label: 'Delete look…',
        danger: true,
        action: () => confirmInMenu(`Delete the look “${entry.name}”? Photos it was put on keep their settings.`, 'Delete', async () => {
          await state.lib.deleteLook(id);
          if (shown === id) shown = '';
          render();
        }),
      },
    ]);
  }

  // ------------------------------------------------------------ save
  function nextName() {
    const taken = new Set((state.lib ? state.lib.looks : []).map((l) => l.name));
    let n = taken.size + 1;
    while (taken.has(`Look ${n}`)) n++;
    return `Look ${n}`;
  }

  $('look-save').onclick = () => {
    if (!hasPhoto()) return;
    $('look-name').value = nextName();
    $('look-dialog').showModal();
    $('look-name').select();
  };
  // Enter in the name saves (the form's default button would be Cancel, the first one).
  $('look-name').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    $('look-dialog').close('ok');
  });
  $('look-dialog').addEventListener('close', async () => {
    if ($('look-dialog').returnValue !== 'ok' || !hasPhoto()) return;
    try {
      flushSave();
      const look = makeLook(currentEdits(), $('look-name').value, { whiteBalance: $('look-wb').checked, local: $('look-local').checked, details: $('look-details').checked });
      await state.lib.addLook(look.name, look);
      render();
    } catch (err) {
      showError(err);
    }
  });

  // ------------------------------------------------------------ import
  $('look-import').onclick = () => $('look-file').click();
  $('look-file').onchange = async () => {
    const files = [...$('look-file').files];
    $('look-file').value = '';
    let added = 0;
    for (const file of files) {
      try {
        const look = parseLook(await file.text());
        await state.lib.addLook(look.name || file.name.replace(/\.[^.]+$/, ''), look);
        added++;
      } catch (err) {
        showNotice(`${file.name} was not added`, err.message);
      }
    }
    if (added) render();
  };

  render();
  return { render, describeLook };
}
