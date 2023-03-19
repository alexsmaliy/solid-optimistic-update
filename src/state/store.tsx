import type { JSXElement } from "solid-js"
import type { SyncedStoreContext, Widget, Synced } from "~/pages/WidgetPage"

import { createContext, useContext  } from "solid-js"
import { createStore } from "solid-js/store"

import { makeClientsideId } from "~/pages/WidgetPage"
import { SYNCED } from "~/inessentials/networkStatus"

// —————————————————————————————————————————————————————————————————————————————
// Store & Provider

const WidgetContext = createContext<SyncedStoreContext<Widget>>()

export function WidgetProvider(props: {init: Widget[], children?: JSXElement}) {
   const clientsideIds: string[] = []
   const keyedWidgets: Record<string, Synced<Widget>> = Object.fromEntries(function * () {
      for (const widget of props.init) {
         const clientsideId = makeClientsideId()
         clientsideIds.push(clientsideId)
         yield [clientsideId, {
            data: widget,
            meta: {clientsideId, networkStatus: SYNCED}
         }]
      }
   }())
   const [state, setState] = createStore({keyedItems: keyedWidgets, clientsideIds})
   const context = {state, setState}

return <WidgetContext.Provider value={context}>
      {props.children}
   </WidgetContext.Provider>
}

export function useStore() {
   return useContext(WidgetContext)
}