import Database from "better-sqlite3"
import { batch, createContext, createEffect, JSXElement, useContext } from "solid-js"
import { createStore, produce, SetStoreFunction } from "solid-js/store"
import { refetchRouteData, ServerError } from "solid-start"
import { createServerMultiAction$ } from "solid-start/server"
import type { Widget } from "~/routes/index"
import { FAILED, GOT_ERROR, NetworkStatus, SENT_REQUEST, SENT_RETRY, SYNCED } from "~/utility/networkStatus"
import randomString from "~/utility/randomString"
import retryDelay from "~/utility/retryDelay"

// —————————————————————————————————————————————————————————————————————————————
// Types

export type Synced<T> = {
   data: T,
   meta: {
      clientsideId: string,
      networkStatus: NetworkStatus,
   },
}

export type SyncedStore<T> = {
   keyedItems: Record<string, Synced<T>>,
   clientsideIds: string[],
}

export type SyncedStoreContext<T> = {
   state: SyncedStore<T>,
   setState: SetStoreFunction<SyncedStore<T>>,
   runSyncedMutation<
      Item extends Record<string, unknown>,
      KeyField extends keyof Item,
      MutatedField extends keyof Item,
      NewValue extends Item[MutatedField],
      Store extends SyncedStore<Item>,
   >({items, keyField, mutatedField, newValue, sqlTemplate, setStore}: {
      items: Synced<Item>[],
      keyField: KeyField,
      mutatedField: MutatedField,
      newValue: NewValue,
      sqlTemplate: string,
      setStore: SetStoreFunction<Store>
   }): void,
   runSyncedCreation<
      Item extends Record<string, unknown>,
      KeyField extends keyof Item,
      Store extends SyncedStore<Item>,
   >({newItem, keyField, sqlTemplate, setStore}: {
      newItem: Item,
      keyField: KeyField,
      sqlTemplate: string,
      setStore: SetStoreFunction<Store>,
   }): void,
   retryFailedMutations(): void,
   retryFailedCreations(): void,
}

// —————————————————————————————————————————————————————————————————————————————
// Server

async function updateTransaction$(data: {ids: any[], sqlTemplate: string, retryMeta: {
   items: any,
   keyField: any,
   mutatedField: any,
   newValue: any,
   sqlTemplate: any,
   setStore: any
}}) {
   const db = new Database("./src/database/Omark.sqlite3", {fileMustExist: true})
   db.pragma("journal_mode = WAL")
   try {
      const results = db.transaction(ids => {
         const results: Database.RunResult[] = []
         for (const id of ids) results.push(db.prepare(data.sqlTemplate).run(id))
         return results
      })(data.ids)
      const _ = await new Promise(resolve => setTimeout(resolve, 1000)) // artificially slow endpoint
      return results
   }
   catch (err) {
      console.error("Error while running DB transaction serverside: ", err)
      return new ServerError(`Error while running DB transaction serverside: ${(err as Error).message}`)
   }
}

async function insertTransaction$(data: {item: Record<string, unknown>, sqlTemplate: string}) {
   const db = new Database("./src/database/Omark.sqlite3", {fileMustExist: true})
   db.pragma("journal_mode = WAL")
   try {
      const result = db.prepare(data.sqlTemplate).all(data.item) // make sure the insert query has @prop placeholders!
      const _ = await new Promise(resolve => setTimeout(resolve, 1000)) // artificially slow endpoint
      return result
   }
   catch (err) {
      console.error("Error while running DB transaction serverside: ", err)
      return new ServerError(`Error while running DB transaction serverside: ${(err as Error).message}`)
   }
}

// —————————————————————————————————————————————————————————————————————————————
// Store & Provider

const WidgetContext = createContext<SyncedStoreContext<Widget>>()

export function WidgetProvider(props: {init: Widget[], children?: JSXElement}) {
   const clientsideIds: string[] = []
   const keyedWidgets: Record<string, Synced<Widget>> = Object.fromEntries(function * () {
      for (const widget of props.init) {
         const clientsideId = randomString(8)
         clientsideIds.push(clientsideId)
         yield [clientsideId, {
            data: widget,
            meta: {clientsideId, networkStatus: SYNCED}
         }]
      }
   }())

   const [inflightUpdates, runUpdateInTransaction$] = createServerMultiAction$(updateTransaction$)
   const [inflightInserts, runInsertInTransaction$] = createServerMultiAction$(insertTransaction$)

   function runSyncedMutation<
      Item extends Record<string, unknown>,
      KeyField extends keyof Item,
      MutatedField extends keyof Item,
      NewValue extends Item[MutatedField],
      Store extends SyncedStore<Item>,
   >(
      {items, keyField, mutatedField, newValue, sqlTemplate, setStore}: {
         items: Synced<Item>[],
         keyField: KeyField,
         mutatedField: MutatedField,
         newValue: NewValue,
         sqlTemplate: string,
         setStore: SetStoreFunction<Store>
      },
   ) {
      const ids = items.map(item => item.data[keyField])
      const clientsideIds = items.map(item => item.meta.clientsideId)
      const backup: Map<string, Item[MutatedField]> = new Map()

      // optimistic update
      batch(() => {
         for (const id of clientsideIds) {
            setStore(produce(store => {
               backup.set(id, store.keyedItems[id].data[mutatedField])
               store.keyedItems[id] = {
                  data: {
                     ...store.keyedItems[id].data,
                     [mutatedField]: newValue,
                  },
                  meta: {
                     ...store.keyedItems[id].meta,
                     networkStatus: SENT_REQUEST,
                  }
               }
            }))
         }
      })

      const delay = retryDelay("250ms", "10000ms")
      const numTries = 3

      // the retry/rollback state machine
      function tryRepeatedly(totalTries: number) {
         const retryMeta = {items, keyField, mutatedField, newValue, sqlTemplate, setStore}
         runUpdateInTransaction$({ids, sqlTemplate, retryMeta}).then(res => {
            if (res instanceof Error) {
               if (totalTries > 0) {
                  console.error(`Got error, retrying ${totalTries} times.`, res.message)

                  batch(() => {
                     for (const id of clientsideIds)
                        setStore(produce(store => store.keyedItems[id].meta.networkStatus = GOT_ERROR))
                  })

                  return new Promise(() => {
                     batch(() => {
                        for (const id of clientsideIds)
                           setStore(produce(store => store.keyedItems[id].meta.networkStatus = SENT_RETRY))
                     })
                     setTimeout(() => tryRepeatedly(totalTries - 1), delay.next().value!)
                  })
               }
               else {
                  batch(() => {
                     for (const id of clientsideIds)
                        setStore(produce(store => {
                           console.warn(`Resetting ${String(mutatedField)} of item ${id} back to ${backup.get(id)}`)
                           store.keyedItems[id].data[mutatedField] = backup.get(id)!
                           store.keyedItems[id].meta.networkStatus = FAILED
                        }))
                  })
               }
            }
            else batch(() => {
               for (const id of clientsideIds)
                  setStore(produce(store => store.keyedItems[id].meta.networkStatus = SYNCED))
            })
         })
      }

      tryRepeatedly(numTries)
   }

   function runSyncedCreation<
      Item extends Record<string, unknown>,
      KeyField extends keyof Item,
      Store extends SyncedStore<Item>,
   >({newItem, keyField, sqlTemplate, setStore}: {
      newItem: Item,
      keyField: KeyField,
      sqlTemplate: string,
      setStore: SetStoreFunction<Store>,
   }) {
      const id = randomString(8)

      setStore(produce(store => {
         store.clientsideIds.push(id)
         store.keyedItems[id] = {
            data: newItem,
            meta: {
               clientsideId: id,
               networkStatus: SENT_REQUEST,
            }
         }
      }))

      const delay = retryDelay("250ms", "10000ms")
      const numTries = 3;

      function tryRepeatedly(totalTries: number) {
         runInsertInTransaction$({item: newItem, sqlTemplate}).then(res => {
            if (res instanceof Error) {
               if (totalTries > 0) {
                  console.error(`Got error, retrying ${totalTries} times.`, res.message)
                  setStore(produce(store => store.keyedItems[id].meta.networkStatus = GOT_ERROR))
                  return new Promise(() => {
                     setStore(produce(store => store.keyedItems[id].meta.networkStatus = SENT_RETRY))
                     setTimeout(() => tryRepeatedly(totalTries - 1), delay.next().value!)
                  })
               }
               else {
                  setStore(produce(store => store.keyedItems[id].meta.networkStatus = FAILED))
                  return new Promise(() => {
                     setTimeout(() => setStore(produce(store => {
                        delete store.keyedItems[id]
                        const position = store.clientsideIds.indexOf(id)
                        store.clientsideIds.splice(position, 1)
                     })), 1000)
                  })
               }
            }
            else {
               setStore(produce(store => {
                  store.keyedItems[id].meta.networkStatus = SYNCED
                  store.keyedItems[id].data[keyField] = res[0].id
               }))
            }
         })
      }

      tryRepeatedly(numTries)
   }

   const retryFailedMutations = function retryFailedMutations() {
      console.log("Retrying..", inflightUpdates.length)
      const copy = [...inflightUpdates] // TODO: how to filter this
      for (const update of copy) {
         const meta = update.input.retryMeta
         runSyncedMutation({
            items: meta.items,
            keyField: meta.keyField,
            mutatedField: meta.mutatedField,
            newValue: meta.newValue,
            sqlTemplate: meta.sqlTemplate,
            setStore: meta.setStore
         })
         update.clear()
         let i = copy.indexOf(update)
         inflightUpdates.splice(i, 1) // WHYYYYYY
      }
   }

   function retryFailedCreations() {
      for (const insert of inflightInserts) {
         if (insert.error) {
            runInsertInTransaction$(insert.input)
         }
      }
   }

   const [state, setState] = createStore({keyedItems: keyedWidgets, clientsideIds})
   const context = {state, setState, runSyncedCreation, runSyncedMutation, retryFailedCreations, retryFailedMutations}

   return <WidgetContext.Provider value={context}>
      {props.children}
   </WidgetContext.Provider>
}

export function useStore() {
   return useContext(WidgetContext)
}