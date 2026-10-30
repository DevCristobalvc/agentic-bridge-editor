// Whiteboards: free Excalidraw boards plus every project's board (its kanban lives there too).
import { html, useEffect, useState } from '/vendor/htm-preact.js';
import { api, useStore } from '../api.js';
import { Btn, Icon, IconBtn, Empty, attempt, useMenu, confirmDialog, promptDialog, ago, useNow, shortPath } from '../ui.js';
import { navigate } from '../router.js';
import { Whiteboard } from '../whiteboard.js';

export async function newBoard() {
  const name = await promptDialog({ title: 'Nueva pizarra', label: 'Nombre', placeholder: 'p. ej. Arquitectura del portal', confirm: 'Crear' });
  if (name == null) return;
  const b = await attempt(() => api.post('/api/boards', { name: name.trim() || 'Pizarra' }));
  if (b) navigate('/boards/' + encodeURIComponent(b.ref));
}

function BoardPage({ boardRef }) {
  const boards = useStore((s) => s.boards);
  const [full, setFull] = useState(false);
  const [openMenu, menu] = useMenu();
  const b = boards.find((x) => x.ref === boardRef);
  useEffect(() => { if (boardRef.startsWith('p:')) navigate('/projects/' + boardRef.slice(2) + '?tab=board'); }, [boardRef]);
  if (boardRef.startsWith('p:')) return null;
  const rename = async () => {
    const name = await promptDialog({ title: 'Renombrar pizarra', label: 'Nombre', value: b ? b.name : '', confirm: 'Guardar' });
    if (name && name.trim()) attempt(() => api.patch('/api/boards/' + encodeURIComponent(boardRef), { name: name.trim() }));
  };
  return html`<div class="page" style="max-width:none;padding-bottom:18px">
    <div class="page-head" style="margin-bottom:12px">
      <div class="grow">
        <a href="#/boards" class="muted" style="font-size:12.5px">← Pizarras</a>
        <h2 style="margin-top:4px" onDblClick=${rename} title="Doble clic para renombrar">${b ? b.name : 'Pizarra'}</h2>
        <p>Excalidraw completo: dibuja, pega imágenes, conecta ideas. Se guarda solo y los agentes pueden dejar notas aquí con <span class="mono">bridge_board_note</span>.</p>
      </div>
      <div class="actions">
        <${Btn} icon="maximize" onClick=${() => setFull(true)}>Pantalla completa<//>
        <${IconBtn} icon="more" title="Más" onClick=${(e) => openMenu(e, [
          { label: 'Renombrar', icon: 'pencil', run: rename },
          '-',
          { label: 'Eliminar pizarra', icon: 'trash', danger: true, run: async () => { if (await confirmDialog({ title: 'Eliminar ' + (b ? b.name : 'la pizarra'), text: 'Se borra el dibujo. No se puede deshacer.', confirm: 'Eliminar', danger: true })) { await attempt(() => api.del('/api/boards/' + encodeURIComponent(boardRef))); navigate('/boards'); } } },
        ])} />
      </div>
    </div>
    <${Whiteboard} key=${boardRef} boardRef=${boardRef} title=${b ? b.name : 'Pizarra'} fullscreen=${full} onExitFull=${() => setFull(false)} />
    ${full ? html`<button type="button" class="btn sm" style="position:fixed;right:16px;bottom:16px;z-index:46" onClick=${() => setFull(false)}><${Icon} name="minimize" />Salir de pantalla completa</button>` : null}
    ${menu}
  </div>`;
}

export function Boards({ route }) {
  const boards = useStore((s) => s.boards);
  const now = useNow(60000);
  if (route.param) return html`<${BoardPage} boardRef=${decodeURIComponent(route.param)} />`;
  const free = boards.filter((b) => b.kind === 'free');
  const projectBoards = boards.filter((b) => b.kind === 'project');
  const card = (b) => html`<div class="card hover p-card" onClick=${() => navigate(b.kind === 'project' ? '/projects/' + b.projectId + '?tab=board' : '/boards/' + encodeURIComponent(b.ref))}>
    <div class="thumb"><${Icon} name=${b.kind === 'project' ? 'kanban' : 'board'} /></div>
    <div class="row"><h3 class="grow ellipsis">${b.name}</h3>${b.kind === 'project' ? html`<span class="chip accent">proyecto</span>` : null}</div>
    <div class="muted" style="font-size:12.5px">${b.kind === 'project' ? shortPath(b.path) + ' · ' : ''}${b.updatedAt ? 'editada ' + ago(b.updatedAt, now) : 'sin abrir todavía'}</div>
  </div>`;
  return html`<div class="page">
    <div class="page-head">
      <div><h2>Pizarras</h2><p>Lienzos de Excalidraw para pensar, diagramar y planear. La de cada proyecto es además su tablero kanban, conectado a todo.md.</p></div>
      <div class="actions"><${Btn} kind="primary" icon="plus" onClick=${newBoard}>Nueva pizarra<//></div>
    </div>
    ${free.length ? html`<div class="cards board-cards">${free.map(card)}</div>` : html`<${Empty} icon="board" title="Tu primera pizarra" action=${html`<${Btn} kind="primary" icon="plus" onClick=${newBoard}>Nueva pizarra<//>`}>
      Dibuja arquitectura, flujos o ideas sueltas con todo Excalidraw: formas, flechas, texto a mano, imágenes y bibliotecas.<//>`}
    ${projectBoards.length ? html`<div class="section-title"><${Icon} name="kanban" />De tus proyectos<span class="dim">tablero + lienzo libre</span></div>
      <div class="cards board-cards">${projectBoards.map(card)}</div>` : null}
  </div>`;
}
