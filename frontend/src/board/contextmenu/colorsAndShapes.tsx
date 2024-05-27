import { componentScope, h } from "harmaja"
import * as L from "lonna"
import { NOTE_COLORS } from "../../../../common/src/colors"
import { ColoredItem, isColoredItem } from "../../../../common/src/domain"
import { colorsSubMenu } from "./colors"
import { SubmenuProps } from "./ContextMenuView"
import { getShapeIcon, shapesSubMenu } from "./shapes"
import { disabledColor } from "../../components/UIColors"
import { canChangeShapeAndColor } from "../board-permissions"

function createSubMenu(props: SubmenuProps) {
    return (
        <div className="submenu">
            {colorsSubMenu(props)}
            {shapesSubMenu(props)}
        </div>
    )
}

export function colorsAndShapesMenu(props: SubmenuProps) {
    const coloredItems = L.view(props.focusedItems, (items) => items.items.filter(isColoredItem))
    const representativeColoredItem: L.Property<ColoredItem | null> = L.view(coloredItems, (items) => items[0] || null)
    const enabled = L.view(coloredItems, (items) => items.some(canChangeShapeAndColor))
    return L.view(representativeColoredItem, enabled, (item, enabled) => {
        if (!item) return []
        const color = NOTE_COLORS.find((c) => c.color === item.color) || { name: "custom", color: item.color }
        const shapeIcon = getShapeIcon(item)

        return !item
            ? []
            : [
                  <div className="colors-shapes icon-group">
                      <span
                          className={`icon color ${color.name} ${enabled ? "" : "disabled"}`}
                          onClick={() => props.submenu.modify((v) => (v == createSubMenu ? null : createSubMenu))}
                      >
                          {shapeIcon(enabled ? color.color : disabledColor, enabled ? color.color : undefined)}
                      </span>
                  </div>,
              ]
    })
}
