import Database from "better-sqlite3";
import { batch, createContext, createMemo, For, JSXElement, Match, Show, Switch, useContext } from "solid-js";
import { createStore, produce, SetStoreFunction } from "solid-js/store";
import { createServerAction$, createServerData$, ServerError } from "solid-start/server";
import WayneIcon from "~/components/WayneIcon";
import { FAILED, GOT_ERROR, SENT_REQUEST, SENT_RETRY, SYNCED, type NetworkStatus } from "~/inessentials/networkStatus";
import { randomString } from "~/inessentials/randomString";
import { retryDelayGen } from "~/inessentials/retryDelay";

type Synced<T> = {
    data: T,
    meta: {
        clientsideId: string,
        networkStatus: NetworkStatus,
    },
}

type SyncedStore<T> = {
    keyedItems: Record<string, Synced<T>>,
    clientsideIds: string[],
}

type SyncedStoreContext<T> = {
    state: SyncedStore<T>,
    setState: SetStoreFunction<SyncedStore<T>>,
}

type Widget = {
    id: number,
    description: string,
    active: boolean,
}

const WidgetContext = createContext<SyncedStoreContext<Widget>>()

function WidgetProvider(props: {init: Widget[], children?: JSXElement}) {
    const clientsideIds: string[] = []
    const keyedWidgets: Record<string, Synced<Widget>> = Object.fromEntries(function*() {
        for (const widget of props.init) {
            const clientsideId = randomString(8)
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

function useStore() {
    return useContext(WidgetContext)
}

export default function WidgetPage() {
    const widgets = createServerData$(async _unused => {
        const db = new Database("./src/database/d1/Omark.sqlite3", {fileMustExist: true})
        db.pragma("journal_mode = WAL")
        const results: Widget[] = db.prepare<Widget[]>("SELECT * FROM widgets;").all()
        const widgets = results.map(({id, description, active}) => ({id, description, active: !!active}))
        return widgets
    })

    return (
        <Show when={widgets()} fallback={<p>Fallback for no widgets.</p>}>
            <WidgetProvider init={widgets()!}>
                <Widgets />
            </WidgetProvider>
        </Show>
    )
}

function Widgets() {
    const {state, setState} = useStore()!

    // for use by runSyncedMutation() and should really be defined inside it
    const [_, runSqlInTransaction$] = createServerAction$(async (data: {ids: any[], sqlTemplate: string}) => {
        const db = new Database("./src/database/d1/Omark.sqlite3", {fileMustExist: true})
        db.pragma("journal_mode = WAL")
        try {
            const results = db.transaction(ids => {
                const results = []
                for (const id of ids) results.push(db.prepare(data.sqlTemplate).run(id))
                return results
            })(data.ids)
            const _ = await new Promise(resolve => setTimeout(resolve, 1000)) // artificially slow endpoint
            return results
        } catch (err) {
            console.error("Error while running DB transaction serverside: ", err)
            return new ServerError(`Error while running DB transaction serverside: ${(err as Error).message}`)
        }
    })

    function runSyncedMutation<
        Item,
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
        const ids = items.map(item => {
            const data: Item = item.data
            const key: Item[KeyField] = data[keyField]
            return key
        })
        const clientsideIds = items.map(item => item.meta.clientsideId)
        
        const backup: Map<string, Item[MutatedField]> = new Map()

        batch(() => {
            for (const id of clientsideIds) {
                setStore(produce(store => {
                    backup.set(id, store.keyedItems[id].data[mutatedField])
                    store.keyedItems[id].data[mutatedField] = newValue
                    store.keyedItems[id].meta.networkStatus = SENT_REQUEST
                }))
            }
        })

        const retryDelay = retryDelayGen("250ms", "10000ms")
        const numTries = 3;

        (function tryRepeatedly(totalTries: number) {
            runSqlInTransaction$({ids, sqlTemplate}).then(res => {
                if (res instanceof Error) {
                    if (totalTries > 0) {
                        console.error(`Got error, retrying ${totalTries} times.`, res.message)
                        batch(() => {
                            for (const id of clientsideIds)
                                setStore(produce(store => {
                                    store.keyedItems[id].data[mutatedField] = newValue // redundant, but necessary?
                                    store.keyedItems[id].meta.networkStatus = GOT_ERROR
                                }))
                        })
                        const delay = retryDelay.next().value
                        return new Promise(() => {
                            batch(() => {
                                for (const id of clientsideIds)
                                    setStore(produce(store => {
                                        store.keyedItems[id].data[mutatedField] = newValue // redundant, but necessary?
                                        store.keyedItems[id].meta.networkStatus = SENT_RETRY
                                    }))
                            })
                            setTimeout(() => tryRepeatedly(totalTries - 1), delay)
                        })
                    } else {
                        batch(() => {
                            for (const id of clientsideIds)
                                setStore(produce(store => {
                                    console.warn(`Resetting ${String(mutatedField)} of item ${id} back to ${backup.get(id)}`)
                                    store.keyedItems[id].data[mutatedField] = backup.get(id)!
                                    store.keyedItems[id].meta.networkStatus = FAILED
                                }))
                        })
                    }
                } else
                    batch(() => {
                        for (const id of clientsideIds)
                            setStore(produce(store => store.keyedItems[id].meta.networkStatus = SYNCED))
                    })
            })
        })(numTries)
    }

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

    const clientsideIdsMemo = createMemo(
        () => state.clientsideIds
    )

    const clientsideWidgetsMemo = createMemo(
        () => clientsideIdsMemo().map(id => state.keyedItems[id])
    )

    return (
        <>
        <button onClick={() => setActive(clientsideWidgetsMemo())}>SET ALL ACTIVE</button>
        <button onClick={() => setInactive(clientsideWidgetsMemo())}>SET ALL INACTIVE</button>
        <button onClick={() => {/* TODO */}}>ADD WIDGET</button>
        <For each={clientsideWidgetsMemo()}>
            {
                (widget, index) => {
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
                                <Match when={meta.networkStatus === FAILED}><WayneIcon icon="gpp_bad"/></Match>
                                <Match when={meta.networkStatus === GOT_ERROR}><WayneIcon icon="gpp_maybe"/></Match>
                                <Match when={meta.networkStatus === SENT_REQUEST}><WayneIcon icon="arming_countdown"/></Match>
                                <Match when={meta.networkStatus === SENT_RETRY}><WayneIcon icon="gpp_maybe"/></Match>
                                <Match when={meta.networkStatus === SYNCED}><WayneIcon icon="shield"/></Match>
                            </Switch>
                        </div>
                    )
                }
            }
        </For>
        </>
    )
}
