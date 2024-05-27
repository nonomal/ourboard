import {
    AppEvent,
    BoardHistoryEntry,
    canWrite,
    checkBoardAccess,
    Id,
    isBoardItemEvent,
    isPersistableBoardItemEvent,
    newISOTimeStamp,
} from "../../common/src/domain"
import { getBoard, maybeGetBoard, updateBoards } from "./board-state"
import { getBoardInfo, renameBoardConvenienceColumnOnly, updateBoardAccessPolicy } from "./board-store"
import { handleCommonEvent } from "./common-event-handler"
import { MessageHandlerResult } from "./connection-handler"
import { WS_HOST_DEFAULT, WS_HOST_LOCAL, WS_PROTOCOL } from "./host-config"
import { obtainLock } from "./locker"
import { associateUserWithBoard } from "./user-store"
import { addSessionToBoard, broadcastBoardEvent, getSession } from "./websocket-sessions"
import { toBuffer, WsWrapper } from "./ws-wrapper"

export const handleBoardEvent = (allowedBoardId: Id | null, getSignedPutUrl: (key: string) => string) => async (
    socket: WsWrapper,
    appEvent: AppEvent,
): Promise<MessageHandlerResult> => {
    if (await handleCommonEvent(socket, appEvent)) return true
    const session = getSession(socket)
    if (!session) {
        console.error("Session missing for socket " + socket.id)
        return true
    }
    if (appEvent.action === "board.join") {
        //await sleep(3000) // simulate latency

        const boardInfo = await getBoardInfo(appEvent.boardId)
        if (!boardInfo) {
            console.warn(`Trying to join unknown board ${appEvent.boardId}`)
            session.sendEvent({
                action: "board.join.denied",
                boardId: appEvent.boardId,
                reason: "not found",
            })
            return true
        }
        const wsHost = boardInfo.ws_host ?? WS_HOST_DEFAULT

        if (!allowedBoardId || appEvent.boardId !== allowedBoardId || !WS_HOST_LOCAL.includes(wsHost)) {
            // Path - board id mismatch -> always redirect

            const wsAddress = `${WS_PROTOCOL}://${wsHost}/socket/board/${appEvent.boardId}`
            /* console.info(
                    `Trying to join board ${appEvent.boardId} on socket for board ${allowedBoardId}, board host ${wsHost} local hostnames ${WS_HOST_LOCAL}`,
            )*/

            session.sendEvent({
                action: "board.join.denied",
                boardId: appEvent.boardId,
                reason: "redirect",
                wsAddress,
            })
            return true
        }

        let board = (await getBoard(appEvent.boardId))!

        const accessPolicy = board.board.accessPolicy
        const accessLevel = checkBoardAccess(accessPolicy, session.userInfo)
        if (session.userInfo.userType === "authenticated") {
            if (accessLevel === "none") {
                console.warn("Access denied to board by user not on allowList")
                session.sendEvent({
                    action: "board.join.denied",
                    boardId: appEvent.boardId,
                    reason: "forbidden",
                })
                return true
            } else {
                await associateUserWithBoard(session.userInfo.userId, appEvent.boardId)
            }
        } else {
            if (accessLevel === "none") {
                console.warn("Access denied to board by anonymous user")
                session.sendEvent({
                    action: "board.join.denied",
                    boardId: appEvent.boardId,
                    reason: "unauthorized",
                })
                return true
            }
        }
        await addSessionToBoard(board, socket, accessLevel, appEvent.initAtSerial)
        return true
    }

    if (!session.boardSession) {
        console.warn("Trying to send event to board without session", appEvent)
        return true
    }

    if (isBoardItemEvent(appEvent)) {
        const boardId = appEvent.boardId
        const state = await getBoard(boardId)
        if (!state) {
            return true // Just ignoring for now, see above todo
        }
        if (!canWrite(session.boardSession.accessLevel)) {
            console.warn("Trying to change read-only board")
            return true
        }
        obtainLock(state.locks, appEvent, socket) // Allow even if was locked (offline use)
        if (isPersistableBoardItemEvent(appEvent)) {
            if (!session.isOnBoard(appEvent.boardId)) {
                console.warn("Trying to send event to board without valid session")
            } else {
                let historyEntry: BoardHistoryEntry = {
                    ...appEvent,
                    user: session.userInfo,
                    timestamp: newISOTimeStamp(),
                }
                try {
                    const serial = updateBoards(state, historyEntry)
                    historyEntry = { ...historyEntry, serial }
                    broadcastBoardEvent(historyEntry, session)
                    if (appEvent.action === "board.rename") {
                        // special case: keeping name up to date as it's in a separate column
                        await renameBoardConvenienceColumnOnly(appEvent.boardId, appEvent.name)
                    }
                    if (appEvent.action === "board.setAccessPolicy") {
                        if (session.boardSession.accessLevel !== "admin") {
                            console.warn("Trying to change access policy without admin access")
                            return true
                        }
                        await updateBoardAccessPolicy(appEvent.boardId, appEvent.accessPolicy)
                    }
                    return { boardId, serial }
                } catch (e) {
                    console.warn(`Error applying event ${JSON.stringify(appEvent)}: ${e} -> forcing board refresh`)
                    session.sendEvent({ action: "board.action.apply.failed" })
                    return true
                }
            }
        } else if (appEvent.action === "item.unlock") {
            return true
        }
    } else {
        switch (appEvent.action) {
            case "cursor.move": {
                const { boardId, position } = appEvent
                const { x, y } = position
                const state = maybeGetBoard(boardId)
                if (state) {
                    const session = getSession(socket)
                    if (session && session.isOnBoard(appEvent.boardId)) {
                        state.cursorPositions[socket.id] = { x, y, sessionId: socket.id }
                        state.cursorsMoved = true
                    }
                }
                return true
            }
            case "user.bringAllToMe": {
                const session = getSession(socket)
                const state = maybeGetBoard(appEvent.boardId)
                if (session && state && session.isOnBoard(appEvent.boardId)) {
                    if (session.sessionId !== appEvent.sessionId) {
                        console.warn("Incorrect sessionId in user.bringAllToMe")
                    } else {
                        broadcastBoardEvent(appEvent, session)
                    }
                }
                return true
            }
            case "asset.put.request": {
                const { assetId } = appEvent
                const signedUrl = getSignedPutUrl(assetId)
                socket.send(toBuffer({ action: "asset.put.response", assetId, signedUrl }))
                return true
            }
        }
    }
    return false
}
