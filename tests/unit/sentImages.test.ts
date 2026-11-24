import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import SentImages from "$lib/components/conversation/SentImages.svelte";

afterEach(cleanup);

const png = { mediaType: "image/png", data: "AAAA" };
const jpeg = { mediaType: "image/jpeg", data: "BBBB" };

describe("the images a sent message carries", () => {
  it("opens each by its own source on a click", async () => {
    const onOpen = vi.fn();
    const { getAllByTestId } = render(SentImages, { images: [png, jpeg], onOpen });
    const thumbs = getAllByTestId("sent-image");
    await fireEvent.click(thumbs[1]);
    await fireEvent.click(thumbs[0]);
    expect(onOpen.mock.calls).toEqual([
      [{ src: "data:image/jpeg;base64,BBBB", caption: "Sent image 2 of 2" }],
      [{ src: "data:image/png;base64,AAAA", caption: "Sent image 1 of 2" }],
    ]);
  });

  it("names a lone image plainly", async () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(SentImages, { images: [png], onOpen });
    await fireEvent.click(getByTestId("sent-image"));
    expect(onOpen.mock.calls[0][0].caption).toBe("Sent image");
  });

  it("is a button the thread walks, named by its place among them", () => {
    const { getAllByTestId } = render(SentImages, { images: [png, jpeg, png], onOpen: vi.fn() });
    const thumbs = getAllByTestId("sent-image");
    expect(thumbs.map((thumb) => thumb.tagName)).toEqual(["BUTTON", "BUTTON", "BUTTON"]);
    expect(thumbs.map((thumb) => thumb.getAttribute("aria-label"))).toEqual([
      "Open image 1 of 3",
      "Open image 2 of 3",
      "Open image 3 of 3",
    ]);
    for (const thumb of thumbs) {
      expect(thumb.hasAttribute("data-thread-item")).toBe(true);
      expect(thumb.getAttribute("tabindex")).toBe("-1");
    }
  });

  it("opens from the keyboard, where a button does", async () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(SentImages, { images: [png], onOpen });
    const thumb = getByTestId("sent-image");
    thumb.focus();
    // A button's own activation: Enter and Space both click it.
    await fireEvent.click(thumb);
    expect(document.activeElement).toBe(thumb);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("says plainly that an image with no bytes is gone, and is no control", () => {
    const { getByTestId, queryByTestId } = render(SentImages, { images: [{ mediaType: "image/png", data: "" }], onOpen: vi.fn() });
    expect(queryByTestId("sent-image")).toBeNull();
    expect(getByTestId("sent-image-gone").textContent).toBe("Image 1 is no longer available");
  });

  it("draws plain pictures where there is no viewer to open them in", () => {
    const { queryByTestId, getByAltText } = render(SentImages, { images: [png] });
    expect(queryByTestId("sent-image")).toBeNull();
    expect(getByAltText("Attached image 1")).toBeTruthy();
  });
});
