import { h } from "harmaja"
import * as L from "lonna"
import { Board, Container, Item, findItem, isContainer } from "../../../../common/src/domain"
import { TileIcon } from "../../components/Icons"
import { contentRect, organizeItems, packableItems } from "../item-organizer"
import { packItems } from "../item-packer"
import { SubmenuProps } from "./ContextMenuView"
import { canMove } from "../board-permissions"

export function areaTilingMenu({ board, focusedItems, dispatch }: SubmenuProps) {
    const packables = L.view(focusedItems, (items) => {
        if (items.items.length === 1) {
            if (isContainer(items.items[0])) return items.items
        }
        if (items.items.length >= 1) {
            const containerIds = new Set(items.items.map((i) => i.containerId))
            if (containerIds.size === 1 && [...containerIds][0]) return items.items
        }
        return []
    })
    const enabled = L.view(packables, (items) => items.some(canMove))
    const className = enabled.pipe(L.map((e) => (e ? "icon" : "icon disabled")))

    return L.view(
        packables,
        (ps) => ps.length > 0,
        (show) =>
            show
                ? [
                      <div className="icon-group area-options">
                          <span
                              className={className}
                              title="Organize contents"
                              onClick={() => packArbitraryItems(packables.get())}
                          >
                              <TileIcon />
                          </span>
                      </div>,
                  ]
                : [],
    )

    function packArbitraryItems(items: Item[]) {
        const b = board.get()
        if (items.length === 1 && isContainer(items[0])) {
            packItemsInsideContainer(items[0], b)
        } else {
            packItemsInsideContainer(findItem(b)(items[0].containerId!) as Container, b)
        }
    }
    function packItemsInsideContainer(container: Container, b: Board) {
        const targetRect = contentRect(container)
        const itemsToPack = packableItems(container, b)
        let organizedItems = organizeItems(itemsToPack, [], targetRect)
        if (organizedItems.length === 0) {
            console.log("Packing")
            // Already organized -> Pack into equal size to fit
            const packResult = packItems(targetRect, itemsToPack)

            if (!packResult.ok) {
                console.error("Packing container failed: " + packResult.error)
                return
            }
            organizedItems = packResult.packedItems
        }

        dispatch({ action: "item.update", boardId: board.get().id, items: organizedItems })
    }
}
