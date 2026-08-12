import { expect, test } from "vitest";
import { downloadHref } from "./pdf-preview-url";

test("drops the preview flag, which is what flips the route to attachment", () => {
  expect(downloadHref("/receipts/HR-000001/pdf?preview=1")).toBe("/receipts/HR-000001/pdf");
});

test("keeps every other parameter, and their order", () => {
  expect(downloadHref("/admin/items/qr-sheet/pdf?items=a,b,c&preview=1"))
    .toBe("/admin/items/qr-sheet/pdf?items=a%2Cb%2Cc");
});

test("a URL with no preview flag is unchanged", () => {
  expect(downloadHref("/i/abc123/qr/pdf")).toBe("/i/abc123/qr/pdf");
});

// Only the exact `preview` key goes. A prefix match would be a silent bug: the
// route reads `searchParams.has("preview")`, so dropping a merely similar param
// would change a request nobody asked to change.
test("removes only the exact preview key", () => {
  expect(downloadHref("/receipts/HR-000001/pdf?previewMode=wide&preview=1"))
    .toBe("/receipts/HR-000001/pdf?previewMode=wide");
});
