import { AddDialog } from "../screens/AddDialog";
import { AddPanel } from "./AddPanel";
import { DropLayer } from "./DropLayer";

/** Everything the add flow needs on every screen: OS file drags, the C4 panel and the A4 dialog. */
export function AddHost() {
  return (
    <>
      <DropLayer />
      <AddPanel />
      <AddDialog />
    </>
  );
}
