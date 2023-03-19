import Database from "better-sqlite3"
import { createMemo, For, Match, Show, Switch } from "solid-js"
import { createServerData$ } from "solid-start/server"
import Icon from "~/components/Icon"
import { Synced, useStore, WidgetProvider } from "~/state/store"
import { FAILED, GOT_ERROR, SENT_REQUEST, SENT_RETRY, SYNCED } from "~/utility/networkStatus"
import randomString from "~/utility/randomString"

// —————————————————————————————————————————————————————————————————————————————
// Types & Utility

export type Widget = {
   id: number,
   description: string,
   active: boolean,
}

// —————————————————————————————————————————————————————————————————————————————
// Server

function getAllWidgets$() {
   const db = new Database("./src/database/Omark.sqlite3", {fileMustExist: true})
   db.pragma("journal_mode = WAL")
   const results: Widget[] = db.prepare<Widget[]>("SELECT * FROM widgets;").all()
   const widgets = results.map(({id, description, active}) => ({id, description, active: !!active}))
   return widgets
}

// —————————————————————————————————————————————————————————————————————————————
// Widget

export default function WidgetPage() {
   const widgets = createServerData$(getAllWidgets$)

   return (
      <Show when={widgets()} fallback={<p>Fallback for no widgets.</p>}>
         <WidgetProvider init={widgets()!}>
            <Widgets />
         </WidgetProvider>
      </Show>
   )
}

function Widgets() {
   const { state, setState, runSyncedCreation, runSyncedMutation, retryFailedCreations, retryFailedMutations } = useStore()!

   const setActive = (widgets: Synced<Widget>[]) => runSyncedMutation({
      items: widgets,
      keyField: "id",
      mutatedField: "active",
      newValue: true,
      // should be idempotent and reflect what the clientside update is
      sqlTemplate: "UPDATE widgets SET active = TRUE WHERE id = ?;",
      setStore: setState,
   })

   const setInactive = (widgets: Synced<Widget>[]) => runSyncedMutation({
      items: widgets,
      keyField: "id",
      mutatedField: "active",
      newValue: false,
      // should be idempotent and reflect what the clientside update is
      sqlTemplate: "UPDATE widgets SET active = FALSE WHERE id = ?;",
      setStore: setState,
   })

   const createRandomNew = () => {
      const widget = { description: `${randomString(4)} widget`, active: true } as Widget
      runSyncedCreation({
         newItem: widget,
         keyField: "id",
         setStore: setState,
         sqlTemplate: "INSERT INTO widgets (description, active) VALUES (@description, TRUE) RETURNING *;"
      })
   }

   const clientsideIdsMemo = createMemo(() => state.clientsideIds)

   const clientsideWidgetsMemo = createMemo(
      () => clientsideIdsMemo().map(id => state.keyedItems[id])
   )

   return <>
      <button onClick={() => setActive(clientsideWidgetsMemo())}>SET ALL ACTIVE</button>
      <button onClick={() => setInactive(clientsideWidgetsMemo())}>SET ALL INACTIVE</button>
      <button onClick={() => createRandomNew()}>ADD WIDGET</button>
      <button onClick={() => retryFailedMutations()}>RETRY MUTATIONS</button>
      <For each={clientsideWidgetsMemo()}>
         { (widget, index) => {
            const i = createMemo(() => index())
            const data = widget.data
            const meta = widget.meta
            return (
               <div class="widget-container">
                  <div class={`widget ${meta.networkStatus} ${data.active ? "active" : "inactive"}`} id={`widget-${i()}`}>
                     <div class="id">{data.id}</div>
                     <div class="description">{data.description}</div>
                     <fieldset>
                        <input
                           onClick={() => !data.active && setActive([widget])}
                           type="radio"
                           name={`toggle-${i()}`}
                           id={`is-active-${i()}`}
                           checked={data.active}
                           disabled={meta.networkStatus !== SYNCED}
                        />
                        <label for={`is-active-${i()}`}>Active</label>
                        <input
                           onClick={() => data.active && setInactive([widget])}
                           type="radio"
                           name={`toggle-${i()}`}
                           id={`is-inactive-${i()}`}
                           checked={!data.active}
                           disabled={meta.networkStatus !== SYNCED}
                        />
                        <label for={`is-inactive-${i()}`}>Inactive</label>
                     </fieldset>
                  </div>
                  <div class={`widget-overlay ${meta.networkStatus}`}></div>
                  <Switch>
                     <Match when={meta.networkStatus === FAILED}><Icon icon="gpp_bad"/></Match>
                     <Match when={meta.networkStatus === GOT_ERROR}><Icon icon="gpp_maybe"/></Match>
                     <Match when={meta.networkStatus === SENT_REQUEST}><Icon icon="arming_countdown"/></Match>
                     <Match when={meta.networkStatus === SENT_RETRY}><Icon icon="gpp_maybe"/></Match>
                     <Match when={meta.networkStatus === SYNCED}><Icon icon="shield"/></Match>
                  </Switch>
               </div>
            )
         }}
      </For>
   </>
}