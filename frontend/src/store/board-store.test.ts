import { describe, expect, it } from "vitest"

import { BoardStore } from "./board-store"
import * as L from "lonna"
import {
    EventFromServer,
    UIEvent,
    EventWrapper,
    Id,
    newBoard,
    newNote,
    Board,
    BoardHistoryEntry,
    getBoardAttributes,
    JoinBoard,
} from "../../../common/src/domain"
import { UserSessionState } from "./user-session-store"
import { LocalStorageBoard } from "./board-local-store"
import { sleep } from "../../../common/src/sleep"
import { mkBootStrapEvent } from "../../../common/src/migration"
import * as WebSocket from "ws"

const otherUserEventAttributes = { user: { userType: "unidentified", nickname: "joe" }, timestamp: "0" } as const
const localUser = { userType: "unidentified", nickname: "" } as const

const board0 = newBoard("testboard")
const item1 = newNote("hello1")
const addItem1: BoardHistoryEntry = {
    action: "item.add",
    boardId: board0.id,
    items: [item1],
    connections: [],
    serial: 1,
    ...otherUserEventAttributes,
}
const board1 = { ...board0, serial: 1, items: { [item1.id]: item1 } }
const item1_1 = { ...item1, text: "hello1.1" }
const board1_1 = { ...board1, serial: 2, items: { ...board1.items, [item1.id]: item1_1 } }
const item2 = newNote("hello2")
const board2 = { ...board1, serial: 1, items: { ...board1.items, [item2.id]: item2 } }
const item2_1 = { ...item2, text: "hello2.1" }
const board2_1 = { ...board2, serial: 2, items: { ...board2.items, [item1.id]: item1_1 } }
const board2_2 = { ...board2, serial: 2, items: { ...board2.items, [item1.id]: item1_1, [item2.id]: item2_1 } }

describe("Board Store", () => {
    it("Applies event from server", async () => {
        const { store, serverEvents } = await initBoardStore({ serverSideBoard: board0 })
        expect(store.state.get().board).toEqual(board0)

        serverEvents.push(addItem1)

        expect(store.state.get().board).toEqual(board1)
        expect(store.state.get().serverShadow).toEqual(store.state.get().board)
    })

    it("Applies local event", async () => {
        const { store, serverEvents } = await initBoardStore({ serverSideBoard: board0 })
        expect(store.state.get().board).toEqual(board0)

        // 1. Event applied locally, serverShadow and serial unchanged
        store.dispatch({ action: "item.add", boardId: board0.id, items: [item1], connections: [] })
        expect(store.state.get().board).toEqual({ ...board0, serial: 0, items: { [item1.id]: item1 } })
        expect(store.state.get().serverShadow).toEqual(board0)

        // 2. Ack from server, update serverShadow and serial
        serverEvents.push({ action: "ack", ackId: "", serials: { [board0.id]: 1 } })
        expect(store.state.get().board).toEqual(board1)
        expect(store.state.get().serverShadow).toEqual(store.state.get().board)
    })

    it("Rebases local event when remote event arrives before ack", async () => {
        const { store, serverEvents } = await initBoardStore({ serverSideBoard: board1 })
        expect(store.state.get().board).toEqual(board1)
        // 1. Event applied locally, serverShadow and serial unchanged
        store.dispatch({ action: "item.add", boardId: board0.id, items: [item2], connections: [] })
        expect(store.state.get().board).toEqual(board2)
        expect(store.state.get().serverShadow).toEqual(board1)
        expect(store.state.get().queue.length).toEqual(0)
        expect(store.state.get().sent.length).toEqual(1)

        // 2. Second local event gets queued, not sent to server before ack
        store.dispatch({ action: "item.update", boardId: board0.id, items: [item2_1] })
        expect(store.state.get().board).toEqual({ ...board2, items: { ...board2.items, [item2.id]: item2_1 } })
        expect(store.state.get().serverShadow).toEqual(board1)
        expect(store.state.get().queue.length).toEqual(1)
        expect(store.state.get().sent.length).toEqual(1)

        // 3. Event from server applied to serverShadow and locally, local event still unapplied to serverShadow
        serverEvents.push({
            action: "item.update",
            boardId: board0.id,
            items: [{ ...item1, text: "hello1.1" }],
            serial: 2,
            ...otherUserEventAttributes,
        })
        expect(store.state.get().board).toEqual(board2_2)
        expect(store.state.get().serverShadow).toEqual(board1_1)

        // 4. Ack from server, update serverShadow and serial for the first local event
        serverEvents.push({ action: "ack", ackId: "", serials: { [board0.id]: 3 } })
        expect(store.state.get().board).toEqual({ ...board2_2, serial: 3 })
        expect(store.state.get().serverShadow).toEqual({ ...board2_1, serial: 3 })
        expect(store.state.get().queue.length).toEqual(0)
        expect(store.state.get().sent.length).toEqual(1)

        // 5. Ack from server, update for the second local event
        serverEvents.push({ action: "ack", ackId: "", serials: { [board0.id]: 4 } })
        expect(store.state.get().board).toEqual({ ...board2_2, serial: 4 })
        expect(store.state.get().serverShadow).toEqual(store.state.get().board)
        expect(store.state.get().queue.length).toEqual(0)
        expect(store.state.get().sent.length).toEqual(0)
    })
})

describe("With stored local state", () => {
    it("Without server-side changes", async () => {
        const { store } = await initBoardStore({
            serverSideBoard: board1,
            serverSideHistory: [mkBootStrapEvent(board1.id, board1, board1.serial)],
            locallyStoredBoard: {
                serverShadow: board1,
                queue: [],
            },
        })

        expect(store.state.get().board).toEqual(board1)
        expect(store.state.get().serverShadow).toEqual(store.state.get().board)
    })

    it("With server-side changes", async () => {
        const { store } = await initBoardStore({
            serverSideBoard: { ...board2, serial: 2 },
            serverSideHistory: [
                mkBootStrapEvent(board1.id, board1, board1.serial),
                {
                    action: "item.add",
                    boardId: board0.id,
                    items: [item2],
                    connections: [],
                    serial: 2,
                    ...otherUserEventAttributes,
                },
            ],
            locallyStoredBoard: {
                serverShadow: board1,
                queue: [],
            },
        })

        expect(store.state.get().board).toEqual({ ...board2, serial: 2 })
        expect(store.state.get().serverShadow).toEqual(store.state.get().board)
    })

    it("With queued local changes", async () => {
        const { store } = await initBoardStore({
            serverSideBoard: board1,
            serverSideHistory: [],
            locallyStoredBoard: {
                serverShadow: board1,
                queue: [
                    { action: "item.update", boardId: board0.id, items: [item1_1], timestamp: "0", user: localUser },
                ],
            },
        })

        expect(store.state.get().board).toEqual({ ...board1, items: { [item1.id]: item1_1 } })
    })

    it("With queued local changes and server-side changes", async () => {
        const { store } = await initBoardStore({
            serverSideBoard: { ...board2, serial: 2 },
            serverSideHistory: [
                mkBootStrapEvent(board1.id, board1, board1.serial),
                {
                    action: "item.add",
                    boardId: board0.id,
                    items: [item2],
                    connections: [],
                    serial: 2,
                    ...otherUserEventAttributes,
                },
            ],
            locallyStoredBoard: {
                serverShadow: board1,
                queue: [
                    { action: "item.update", boardId: board0.id, items: [item1_1], timestamp: "0", user: localUser },
                ],
            },
        })

        // The server-side changes should be applied first, then the queued local changes
        expect(store.state.get().board).toEqual({
            ...board2,
            serial: 2,
            items: { ...board2.items, [item1.id]: item1_1 },
        })
    })

    it("Going offline and back online", async () => {
        const { store, serverEvents, connected, sentEvents, replyToJoinRequest } = await initBoardStore({
            serverSideBoard: board0,
        })
        expect(store.state.get().board).toEqual(board0)
        const sentBeforeOffline = sentEvents.slice()

        // Create a local change (add item2)
        const localAddEvent: UIEvent = { action: "item.add", boardId: board0.id, items: [item2], connections: [] }
        const expectedSentEvent = {
            action: "item.add",
            boardId: board0.id,
            items: [item2],
            connections: [],
            timestamp: expect.any(String),
            user: { userType: "unidentified", nickname: "<unknown>" },
        } as const
        store.dispatch(localAddEvent)
        expect(store.state.get().sent).toEqual([expectedSentEvent])
        const expectedAckBundle = {
            // Events are sent in bundles, which include all events in the "sent" buffer when sending.
            ackId: "1",
            events: [expectedSentEvent],
        }
        expect(sentEvents).toEqual([...sentBeforeOffline, expectedAckBundle])

        // Go offline. Sent but not acknowledged events are discarded.
        connected.set(false)
        expect(store.state.get().status).toEqual("offline")
        expect(store.state.get().sent).toEqual([])
        expect(store.state.get().board).toEqual(board0) // Also local state is reset to reflect the discarded event

        // Create local event offline (add item2)
        store.dispatch(localAddEvent)
        expect(store.state.get().board).toEqual({ ...board0, serial: 0, items: { [item2.id]: item2 } })
        expect(store.state.get().serverShadow).toEqual(board0)

        // Go back online
        connected.set(true)
        expect(store.state.get().status).toEqual("joining")
        const expectedRejoinRequest = {
            action: "board.join",
            boardId: board0.id,
            initAtSerial: 0,
        } as const
        expect(sentEvents).toEqual([...sentBeforeOffline, expectedAckBundle, expectedRejoinRequest])

        // Meanwhile, item1 was added on the server. Now server responds to the rejoin request
        replyToJoinRequest(expectedRejoinRequest, board1, [addItem1])
        expect(store.state.get().board).toEqual(board2) // Client has merged changes from server
        expect(store.state.get().sent).toEqual([expectedSentEvent])
        expect(store.state.get().serverShadow).toEqual(board1)
        expect(sentEvents).toEqual([...sentBeforeOffline, expectedAckBundle, expectedRejoinRequest, expectedAckBundle])

        // Ack from server, update serverShadow and serial
        serverEvents.push({ action: "ack", ackId: "", serials: { [board0.id]: 2 } })
        expect(store.state.get().board).toEqual({ ...board2, serial: 2 })
        expect(store.state.get().serverShadow).toEqual({ ...board2, serial: 2 })
    })
})

// TODO: test going offline before getting board.init (case server redirects to other URL)
// TODO: test effects of server event buffering (bufferedServerEvents)
// TODO: test undo, redo buffers

async function waitForBackgroundJobs() {
    await sleep(10)
}

async function initBoardStore({
    serverSideBoard,
    locallyStoredBoard,
    serverSideHistory,
}: {
    serverSideBoard: Board
    locallyStoredBoard?: LocalStorageBoard
    serverSideHistory?: BoardHistoryEntry[]
}) {
    const serverEvents = L.bus<EventFromServer>()
    const boardId = L.constant(serverSideBoard.id)
    const connected = L.atom(true)
    let sentEvents: (UIEvent | EventWrapper)[] = []
    const send = (x: UIEvent | EventWrapper) => sentEvents.push(x)
    const sessionInfo = L.atom<UserSessionState>({
        status: "anonymous",
        sessionId: "",
        nickname: "",
        nicknameSetByUser: false,
        loginSupported: true,
    })

    const connection = {
        connected,
        send,
        bufferedServerEvents: serverEvents,
        sentUIEvents: null as any, // not used by BoardStore,
        newSocket: function () {},
    }

    const localStore = {
        getInitialBoardState: async (boardId: Id): Promise<LocalStorageBoard | undefined> => {
            return locallyStoredBoard
        },
        clearBoardState: async (boardId: Id) => {},
        clearAllPrivateBoards: async () => {},
        storeBoardState: async (newState: LocalStorageBoard) => {},
    }

    const store = BoardStore(boardId, connection, sessionInfo, localStore, WebSocket as any)

    expect(store.state.get().board).toEqual(undefined)
    expect(store.state.get().queue).toEqual([])
    expect(store.state.get().sent).toEqual([])
    expect(store.state.get().serverShadow).toEqual(undefined)
    expect(store.state.get().status).toEqual("none")

    expect(sentEvents).toEqual([])

    await waitForBackgroundJobs()

    sessionInfo.set({
        status: "anonymous",
        nickname: localUser.nickname,
        nicknameSetByUser: false,
        sessionId: "",
        loginSupported: false,
    })

    await waitForBackgroundJobs()

    const expectedJoinRequest = {
        action: "board.join",
        boardId: board0.id,
        initAtSerial: locallyStoredBoard?.serverShadow?.serial,
    } as const
    expect(sentEvents).toEqual([expectedJoinRequest])

    function replyToJoinRequest(
        joinRequest: JoinBoard,
        serverSideBoard: Board,
        serverSideHistory: BoardHistoryEntry[],
    ) {
        const initAtSerial = joinRequest.initAtSerial
        if (initAtSerial != undefined) {
            serverEvents.push({
                action: "board.init.diff",
                first: true,
                last: true,
                recentEvents: serverSideHistory!.filter((e) => e.serial! > initAtSerial),
                boardAttributes: getBoardAttributes(serverSideBoard),
                initAtSerial,
                accessLevel: "read-write",
            })
        } else {
            serverEvents.push({ action: "board.init", board: serverSideBoard, accessLevel: "read-write" })
        }
    }
    replyToJoinRequest(expectedJoinRequest, serverSideBoard, serverSideHistory || [])

    await waitForBackgroundJobs()

    expect(store.state.get().serverShadow).toEqual(serverSideBoard)

    return { store, serverEvents, connected, sentEvents, replyToJoinRequest } as const
}
