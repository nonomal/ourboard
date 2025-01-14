import { componentScope } from "harmaja"
import * as L from "lonna"
import { Board } from "../../../common/src/domain"
import { BoardFocus } from "./board-focus"
import { Dispatch } from "../store/board-store"
import { findSelectedItems, makeCopies } from "./item-cut-copy-paste"
import { controlKey, installKeyboardShortcut } from "./keyboard-shortcuts"

export function itemDuplicateHandler(board: L.Property<Board>, dispatch: Dispatch, focus: L.Atom<BoardFocus>) {
    installKeyboardShortcut(controlKey("d"), () => {
        const currentBoard = board.get()
        const itemsAndConnections = findSelectedItems(focus.get(), currentBoard)
        const { toCreate, toSelect, connections } = makeCopies(itemsAndConnections, 1, 1)
        dispatch({ action: "item.add", boardId: currentBoard.id, items: toCreate, connections })
        focus.set({ status: "selected", ids: new Set(toSelect.map((it) => it.id)) })
    })
}
