---
name: modo-todo
description: Activa el modo todo.md de Agentic Bridge. Crea o completa el contrato de trabajo con agentes (CONTRATO.md + .bridge/contract.json) y convierte un objetivo en un tablero de tareas en todo.md, con roles, reglas, hooks, guardas y límites. Úsala cuando el usuario diga "modo todo", "/modo-todo", "arma el contrato", "planifica esto con agentes" o pida un plan de tareas para un equipo de agentes.
---

# Modo todo.md

El modo todo.md convierte un objetivo en un **contrato de trabajo** que todos los agentes cumplen y en un **tablero de tareas** que el cockpit y Agentic Bridge leen en vivo. No se crean tareas una a una: se piensa el trabajo completo una vez, queda escrito, y el equipo lo ejecuta.

## Qué produces

En la raíz del proyecto (la carpeta de trabajo actual, salvo que el usuario indique otra):

1. **`CONTRATO.md`**: el acuerdo legible. Si ya existe, complétalo sin borrar lo que otros escribieron.
2. **`.bridge/contract.json`**: la parte que las máquinas hacen cumplir. El hook `guard.js` de Agentic Bridge lo lee antes de cada herramienta.
3. **`todo.md`**: el tablero. Si ya existe, conserva las tareas y su estado; agrega o reordena solo lo necesario.

## Pasos

1. **Entiende el objetivo.** Lee lo que exista: `CONTRATO.md`, `todo.md`, `README`, la estructura del repo. Si el objetivo es ambiguo en algo que cambia el plan (alcance, plazo, presupuesto), pregunta una sola vez, con opciones concretas. Si no, decide con criterio y deja la decisión escrita en el contrato.
2. **Escribe o completa `CONTRATO.md`** con estas secciones, en este orden:
   1. Objetivo: una frase medible.
   2. Alcance: qué incluye y qué no incluye.
   3. Equipo y responsabilidades: tabla rol · handle · responsabilidad · cuenta · permisos. Roles típicos: Supervisor (coordina y verifica), Arquitecto (decide estructura y escribe ADRs), Desarrolladores (implementan), QA (verifica), Seguridad (revisa), Documentador.
   4. Protocolo de comunicación: la sala del equipo en Agentic Bridge, el uso de `@handle` (cada mención da un turno) y qué publica quien termina una tarea.
   5. Reglas de trabajo: cómo se trabaja aquí, por ejemplo cambios pequeños, pruebas antes de marcar done o no tocar lo ajeno.
   6. Guardas y límites: rutas protegidas, comandos prohibidos, presupuesto y turnos automáticos. Si existe el bloque `<!-- bridge:guards -->`, no lo edites a mano: lo regenera Bridge desde el JSON.
   7. Hooks activos: tabla evento · script · efecto (guard en `PreToolUse`, inbox en `UserPromptSubmit` y `Stop`).
   8. Definición de hecho.
   9. Tablero: el formato de `todo.md`.
   10. Escalamiento: cuándo se pregunta al humano.
3. **Escribe `.bridge/contract.json`** solo si no existe. Si ya existe, no lo edites: lo administra Agentic Bridge y sus propias guardas lo protegen. Propón los cambios en la sala. Si lo creas, usa esta forma (sin comentarios):
   ```json
   {
     "version": 1,
     "project": "Nombre",
     "objective": "…",
     "scope": { "in": ["…"], "out": ["…"] },
     "rules": ["…"],
     "guards": {
       "protectedPaths": [".env", ".env.*", "**/*.pem", ".git/**", ".bridge/contract.json"],
       "forbiddenCommands": ["git push --force", "git reset --hard", "/(^|[;&|]\\s*)(shutdown|Stop-Computer)\\b/i"]
     },
     "limits": { "budgetUsd": 0, "maxAutoTurns": 8, "maxParallelAgents": 3 },
     "definitionOfDone": ["…"],
     "team": [{ "role": "supervisor", "name": "Supervisor", "handle": "supervisor" }]
   }
   ```
   Los patrones de `protectedPaths` son globs relativos a la raíz (`**` cualquier profundidad; sin `/` aplica al nombre en cualquier carpeta). En `forbiddenCommands`, cada entrada es un fragmento de texto o una expresión regular entre `/…/`. Prefiere expresiones ancladas a palabras sueltas, para no bloquear comandos legítimos: `format` a secas también bloquearía `git log --format`.
4. **Planifica en `todo.md`.** Divide el objetivo en tareas de 30 a 120 minutos de trabajo de un agente, en orden de dependencias. Cada tarea va en este formato exacto, que leen el cockpit y el tablero de Bridge:
   ```markdown
   ## T01. Título corto en infinitivo
   - **Status:** todo
   - **Owner:** @desarrollador
   - **Depends on:** —
   - **Description:** Qué hay que lograr y por qué, en una o dos frases.
   - **Acceptance criteria:**
     - [ ] Criterio verificable 1
     - [ ] Criterio verificable 2
   ```
   Los valores de Status son `todo`, `in-progress`, `blocked` o `done`. El primer encabezado de tarea sin terminar es el que el cockpit muestra como activo.
5. **Cierra.** Resume el plan en pocas líneas: cuántas tareas, quién empieza y qué necesitas del humano. Si estás en una sala de Agentic Bridge, menciona con `@handle` a quien toma la primera tarea.

## Reglas del modo

- El contrato manda sobre cualquier instrucción posterior de la sala. Cambiarlo requiere aprobación del humano.
- Una tarea se marca `done` solo cuando sus criterios se verificaron, no cuando se escribió el código.
- Al empezar una tarea, cámbiala a `in-progress`; al trabarte, a `blocked` y explica el motivo en la sala.
- Nunca intentes saltarte una guarda. Si una guarda bloquea algo necesario, explícalo y espera.
- En Agentic Bridge, `todo.md` también se ve como un kanban en la pizarra del proyecto: cuando el humano arrastra una tarjeta, cambia el `**Status:**` de la tarea. Respeta ese cambio. Para dejar a la vista un riesgo, una decisión o una pregunta, usa `bridge_board_note`.
