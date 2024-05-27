import * as Y from "yjs"
import { AppEvent, Board, CrdtEnabled, checkBoardAccess, defaultBoardSize } from "../../common/src/domain"
import { addBoard } from "./board-state"
import { fetchBoard } from "./board-store"
import { yWebSocketServer } from "./board-yjs-server"
import { MessageHandlerResult } from "./connection-handler"
import { getAuthenticatedUserFromJWT } from "./http-session"
import {
    associateUserWithBoard,
    dissociateUserWithBoard,
    getUserAssociatedBoards,
    getUserIdForEmail,
} from "./user-store"
import { getSession, logoutUser, setNicknameForSession, setVerifiedUserForSession } from "./websocket-sessions"
import { WsWrapper, toBuffer } from "./ws-wrapper"

export async function handleCommonEvent(socket: WsWrapper, appEvent: AppEvent): Promise<MessageHandlerResult> {
    switch (appEvent.action) {
        case "auth.login.jwt": {
            const user = getAuthenticatedUserFromJWT(appEvent.jwt)
            const session = getSession(socket)
            if (session && user !== null) {
                const userId = await getUserIdForEmail(user.email)
                const userInfo = await setVerifiedUserForSession(user, session)
                console.log(`${user.name} logged in`)
                session.sendEvent({ action: "auth.login.response", success: true, userId })
                if (session.boardSession) {
                    await associateUserWithBoard(userId, session.boardSession.boardId)
                }
                session.sendEvent({
                    action: "user.boards",
                    email: user.email,
                    boards: await getUserAssociatedBoards(userInfo),
                })
            } else if (session) {
                session.sendEvent({ action: "auth.login.response", success: false })
            }
            return true
        }
        case "auth.logout": {
            const session = getSession(socket)
            if (session && session.userInfo.userType === "authenticated") {
                logoutUser(appEvent, socket)
                console.log(`${session.userInfo.name} logged out`)
            }
            socket.close()
            return true
        }
        case "nickname.set": {
            setNicknameForSession(appEvent, socket)
            return true
        }
        case "board.associate": {
            // TODO: maybe access check? Not security-wise necessary
            const session = getSession(socket)
            if (session) {
                if (session.userInfo.userType !== "authenticated") {
                    console.warn("Trying to associate board without authenticated user")
                    return true
                }
                const userId = session.userInfo.userId
                await associateUserWithBoard(userId, appEvent.boardId, appEvent.lastOpened)
            }
            return true
        }
        case "board.dissociate": {
            const session = getSession(socket)
            if (session) {
                if (session.userInfo.userType !== "authenticated") {
                    console.warn("Trying to dissociate board without authenticated user")
                    return true
                }
                const userId = session.userInfo.userId
                await dissociateUserWithBoard(userId, appEvent.boardId)
            }
            return true
        }
        case "board.add": {
            const session = getSession(socket)
            if (session) {
                const { payload } = appEvent
                let template: Board | null = null
                if ("templateId" in payload && payload.templateId) {
                    const aliased = process.env[`BOARD_ALIAS_${payload.templateId}`]
                    const templateId = aliased || payload.templateId
                    const found = await fetchBoard(templateId)
                    if (found) {
                        const accessLevel = checkBoardAccess(found.board.accessPolicy, session.userInfo)
                        if (accessLevel === "none") {
                            console.warn(`Trying to use board ${found.board.id} as template, without board permissions`)
                            return true
                        }
                        template = { ...found.board, accessPolicy: undefined }
                    } else {
                        console.error(`Template ${payload.templateId}${aliased ? `(${templateId})` : ""} not found`)
                    }
                }
                const board = { ...defaultBoardSize, items: {}, connections: [], ...template, ...payload, serial: 0 }
                if (template && template.crdt === CrdtEnabled) {
                    const templateDoc = await yWebSocketServer.docs.getYDocAndWaitForFetch(template.id)
                    const newDoc = await yWebSocketServer.docs.getYDocAndWaitForFetch(board.id)
                    Y.applyUpdate(newDoc, Y.encodeStateAsUpdate(templateDoc))
                }
                await addBoard(board)
                socket.send(toBuffer({ action: "board.add.ack", boardId: board.id }))
            }
            return true
        }
        case "ping": {
            return true
        }
    }
    return false
}
