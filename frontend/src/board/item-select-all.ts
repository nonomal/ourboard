import * as L from "lonna"
import { Board } from "../../../common/src/domain"
import { BoardFocus } from "./board-focus"
import { controlKey, installKeyboardShortcut } from "./keyboard-shortcuts"

export function itemSelectAllHandler(board: L.Property<Board>, focus: L.Atom<BoardFocus>) {
    installKeyboardShortcut(controlKey("a"), () =>
        focus.set({ status: "selected", ids: new Set(Object.keys(board.get().items)) }),
    )
}
