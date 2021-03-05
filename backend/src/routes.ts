import * as express from "express"
import * as Http from "http"
import * as Https from "https"
import * as path from "path"
import * as bodyParser from "body-parser"
import * as Either from "fp-ts/lib/Either"
import {
    Board,
    createBoard,
    EventUserInfo,
    BoardHistoryEntry,
    AppEvent,
    newNote,
    Note,
    Color,
    PersistableBoardItemEvent,
    isNote,
    Container,
    BoardAccessPolicyCodec,
    BoardAccessPolicy,
} from "../../common/src/domain"
import { addBoard, getBoard, updateBoards, ServerSideBoardState } from "./board-state"
import { updateBoard } from "./board-store"
import { broadcastBoardEvent } from "./sessions"
import { encode as htmlEncode } from "html-entities"
import _ from "lodash"
import { RED, YELLOW } from "../../common/src/colors"
import { applyMiddleware, router as typeraRouter } from "typera-express"
import { wrapNative } from "typera-express/middleware"
import { body } from "typera-express/parser"
import { ok } from "typera-common/response"
import * as t from "io-ts"
import { NonEmptyString } from "io-ts-types"

const router = express.Router()

router.get("/assets/external", (req, res) => {
    const src = req.query.src
    if (typeof src !== "string" || ["http://", "https://"].every((prefix) => !src.startsWith(prefix)))
        return res.send(400)
    const protocol = src.startsWith("https://") ? Https : Http

    protocol
        .request(src, (upstreamResponse) => {
            res.writeHead(upstreamResponse.statusCode!, upstreamResponse.headers)
            upstreamResponse
                .pipe(res, {
                    end: true,
                })
                .on("error", (err) => res.status(500).send(err.message))
        })
        .end()
})

router.get("/b/:boardId", async (req, res) => {
    res.sendFile(path.resolve("../frontend/dist/index.html"))
})

const route = applyMiddleware(wrapNative(bodyParser.json()))

const boardCreate = route
    .post("/api/v1/board")
    .use(body(t.type({ name: NonEmptyString, accessPolicy: BoardAccessPolicyCodec })))
    .handler(async (request) => {
        let board: Board = createBoard(request.body.name, request.body.accessPolicy)
        const boardWithHistory = await addBoard(board, true)
        return ok({ id: boardWithHistory.board.id, accessToken: boardWithHistory.accessTokens[0] })
    })

router.use(typeraRouter(boardCreate).handler())

router.put("/api/v1/board/:boardId", bodyParser.json(), async (req, res) => {
    try {
        const boardId = req.params.boardId
        if (!boardId) {
            return res.sendStatus(400)
        }
        let { name, accessPolicy } = req.body
        if (!name) {
            res.status(400).send('Expecting JSON document containing the field "name".')
            return
        }
        let validAccessPolicy = validateAccessPolicy(accessPolicy)
        const board = await getBoard(boardId)
        checkBoardAPIAccess(board, req)
        await updateBoard({ boardId, name, accessPolicy: validAccessPolicy })
        res.json({ ok: true })
    } catch (e) {
        console.error(e)
        if (e instanceof InvalidRequest) {
            res.status(400).send(e.message)
        } else {
            res.sendStatus(500)
        }
    }
})

function validateAccessPolicy(accessPolicy: any): BoardAccessPolicy {
    const accessPolicyResult = BoardAccessPolicyCodec.decode(accessPolicy)
    if (Either.isLeft(accessPolicyResult)) {
        throw new InvalidRequest("Invalid accessPolicy")
    }
    return accessPolicyResult.right
}

function checkBoardAPIAccess(board: ServerSideBoardState, req: express.Request, requireAlways?: boolean) {
    if (requireAlways || board.board.accessPolicy || board.accessTokens.length) {
        if (!req.headers.api_token) {
            throw new InvalidRequest("API_TOKEN required")
        }
        if (!board.accessTokens.some((t) => t === req.headers.api_token)) {
            console.log(`API_TOKEN ${req.headers.api_token} not on list ${board.accessTokens}`)
            throw new InvalidRequest("Invalid API_TOKEN")
        }
    }
}

// TODO: require API_TOKEN header for github too!
router.post("/api/v1/webhook/github/:boardId", bodyParser.json(), async (req, res) => {
    try {
        const boardId = req.params.boardId
        if (!boardId) {
            return res.sendStatus(400)
        }
        let body = req.body
        const board = await getBoard(boardId)
        if (board) {
            if (body.issue) {
                const url = body.issue.html_url
                const title = body.issue.title
                const number = body.issue.number.toString()
                if (!title) throw Error(`Github webhook call board ${boardId}: title missing`)
                if (!url) throw Error(`Github webhook call board ${boardId}: url missing`)
                const state = body.issue.state
                if (state !== "open") {
                    console.log(`Github webhook call board ${boardId}: Item in ${state} state`)
                } else {
                    const linkStart = `<a href=${url}>`
                    const linkHTML = `${linkStart}${htmlEncode(number)}</a> ${htmlEncode(title)}`
                    const existingItem = board.board.items.find((i) => i.type === "note" && i.text.includes(url)) as
                        | Note
                        | undefined
                    const isBug = body.issue.labels.some((l: any) => l.name === "bug")
                    const color = isBug ? RED : YELLOW
                    if (!existingItem) {
                        console.log(`Github webhook call board ${boardId}: New item`)
                        await addItem(board.board, "note", linkHTML, color, "New issues")
                    } else {
                        console.log(`Github webhook call board ${boardId}: Item exists`)
                        const updatedItem: Note = { ...existingItem, color }
                        await dispatchSystemAppEvent({ action: "item.update", boardId, items: [updatedItem] })
                    }
                }
            } else {
                console.warn(`Unrecognized content in webhook call board ${boardId}: ${JSON.stringify(body, null, 2)}`)
            }
        } else {
            console.warn(`Github webhook call for unknown board ${boardId}`)
        }
        res.sendStatus(200)
    } catch (e) {
        console.error(e)
        if (e instanceof InvalidRequest) {
            res.status(400).send(e.message)
        } else {
            res.sendStatus(500)
        }
    }
})

router.post("/api/v1/board/:boardId/item", bodyParser.json(), async (req, res) => {
    try {
        const boardId = req.params.boardId
        if (!boardId) {
            return res.sendStatus(400)
        }
        const { type, text, color, container } = req.body
        console.log(`POST item for board ${boardId}: ${JSON.stringify(req.body)}`)
        const board = await getBoard(boardId)
        checkBoardAPIAccess(board, req)
        if (!board) return res.sendStatus(404)
        await addItem(board.board, type, text, color, container)
        res.status(200).json({ ok: true })
    } catch (e) {
        console.error(e)
        if (e instanceof InvalidRequest) {
            res.status(400).send(e.message)
        } else {
            res.sendStatus(500)
        }
    }
})

router.put("/api/v1/board/:boardId/item/:itemId", bodyParser.json(), async (req, res) => {
    try {
        const { boardId, itemId } = req.params
        if (!boardId) throw new InvalidRequest("boardId missing")
        if (!itemId) throw new InvalidRequest("itemId missing")
        let {
            type,
            text,
            color,
            container,
            replaceTextIfExists,
            replaceColorIfExists,
            replaceContainerIfExists = true,
        } = req.body
        console.log(`PUT item for board ${boardId} item ${itemId}: ${JSON.stringify(req.body)}`)
        if (type !== "note") throw new InvalidRequest("Expecting type: note")
        if (typeof text !== "string" || text.length === 0) throw new InvalidRequest("Expecting non zero-length text")

        const board = await getBoard(boardId)
        checkBoardAPIAccess(board, req)
        if (board) {
            const existingItem = board.board.items.find((i) => i.id === itemId)
            if (existingItem) {
                await updateItem(
                    board.board,
                    type,
                    text,
                    color,
                    container,
                    itemId,
                    replaceTextIfExists,
                    replaceColorIfExists,
                    replaceContainerIfExists,
                )
            } else {
                console.log(`Adding new item`)
                await addItem(board.board, type, text, color, container, itemId)
            }
        } else {
            console.warn(`Github webhook call for unknown board ${boardId}`)
        }
        res.status(200).json({ ok: true })
    } catch (e) {
        console.error(e)
        if (e instanceof InvalidRequest) {
            res.status(400).send(e.message)
        } else {
            res.sendStatus(500)
        }
    }
})

class InvalidRequest extends Error {
    constructor(message: string) {
        super(message)
    }
}

function findContainer(container: string | undefined, board: Board): Container | null {
    if (container !== undefined) {
        if (typeof container !== "string") {
            throw new InvalidRequest("Expecting container to be undefined, or an id or name of an Container item")
        }
        const containerItem = board.items.find(
            (i) => i.type === "container" && (i.text.toLowerCase() === container.toLowerCase() || i.id === container),
        )
        if (!containerItem) {
            throw new InvalidRequest(`Container "${container}" not found by id or name`)
        }
        return containerItem as Container
    } else {
        return null
    }
}

function getItemAttributesForContainer(container: string | undefined, board: Board) {
    const containerItem = findContainer(container, board)
    if (containerItem) {
        return {
            containedId: containerItem.id,
            x: containerItem.x + 2,
            y: containerItem.y + 2,
        }
    }
    return {}
}

async function addItem(board: Board, type: "note", text: string, color: Color, container: string, itemId?: string) {
    if (type !== "note") throw new InvalidRequest("Expecting type: note")
    if (typeof text !== "string" || text.length === 0) throw new InvalidRequest("Expecting non zero-length text")

    let itemAttributes: object = getItemAttributesForContainer(container, board)
    if (itemId) itemAttributes = { ...itemAttributes, id: itemId }

    const item: Note = { ...newNote(text, color || YELLOW), ...itemAttributes }
    const appEvent: AppEvent = { action: "item.add", boardId: board.id, items: [item] }
    dispatchSystemAppEvent(appEvent)
}

async function updateItem(
    board: Board,
    type: "note",
    text: string,
    color: Color,
    container: string,
    itemId: string,
    replaceTextIfExists: boolean | undefined,
    replaceColorIfExists: boolean | undefined,
    replaceContainerIfExists: boolean | undefined,
) {
    const existingItem = board.items.find((i) => i.id === itemId)!
    if (!isNote(existingItem)) {
        throw new InvalidRequest("Unexpected item type")
    }
    const containerItem = findContainer(container, board)
    const currentContainer = findContainer(existingItem.containerId, board)
    const containerAttrs =
        replaceContainerIfExists && containerItem !== currentContainer
            ? getItemAttributesForContainer(container, board)
            : {}

    let updatedItem: Note = {
        ...existingItem,
        ...containerAttrs,
        text: replaceTextIfExists !== false ? text : existingItem.text,
        color: replaceColorIfExists !== false ? color || existingItem.color : existingItem.color,
    }
    if (!_.isEqual(updatedItem, existingItem)) {
        console.log(`Updating existing item`)
        await dispatchSystemAppEvent({ action: "item.update", boardId: board.id, items: [updatedItem] })
    } else {
        console.log(`Not updating: item not changed`)
    }
}

async function dispatchSystemAppEvent(appEvent: PersistableBoardItemEvent) {
    const user: EventUserInfo = { userType: "system", nickname: "Github webhook" }
    let historyEntry: BoardHistoryEntry = { ...appEvent, user, timestamp: new Date().toISOString() }
    console.log(JSON.stringify(historyEntry))
    // TODO: refactor, this is the same sequence as done in connection-handler for messages from clients
    const serial = await updateBoards(historyEntry)
    historyEntry = { ...historyEntry, serial }
    broadcastBoardEvent(historyEntry)
}

export default router