import { AddDialog } from "../screens/AddDialog";
import { AddPanel } from "./AddPanel";
import { DropLayer } from "./DropLayer";
import { PreviewPaste } from "./PreviewPaste";

/** Everything the add flow needs on every screen: OS file drags, Ctrl+V previews, the C4 panel and the A4 dialog. */
export function AddHost() {
  return (
    <>
      <DropLayer />
      <PreviewPaste />
      <AddPanel />
      <AddDialog />
    </>
  );
}
