import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import Sent from "$lib/components/conversation/Sent.svelte";

const openUrl = vi.fn((_url: string) => Promise.resolve());
vi.mock("$lib/core", () => ({ core: () => ({ openUrl }) }));

afterEach(() => {
  cleanup();
  openUrl.mockClear();
});

/** The bubble of a message of words alone. */
function bubble(text: string): HTMLElement {
  return render(Sent, { text, mentions: [], find: "" }).getByTestId("sent-markdown");
}

describe("a click in a message the user typed", () => {
  it("opens a link to the web in the browser", async () => {
    const sent = bubble("See [the docs](https://example.com/docs) and http://plain.example");
    for (const link of sent.querySelectorAll("a")) await fireEvent.click(link);
    expect(openUrl.mock.calls).toEqual([["https://example.com/docs"], ["http://plain.example"]]);
  });

  it("opens nothing else", async () => {
    const sent = bubble("**Go** [top](#top) [mail](mailto:a@b.c) foo@bar.com [run](javascript:alert(1)) [file](file:///etc/passwd)");
    expect(sent.querySelectorAll("a")).toHaveLength(0);
    await fireEvent.click(sent.querySelector("strong")!);
    await fireEvent.click(sent);
    for (const href of ["#top", "mailto:a@b.c", "javascript:alert(1)", "//evil.example"]) {
      const link = document.createElement("a");
      link.setAttribute("href", href);
      sent.append(link);
      await fireEvent.click(link);
    }
    expect(openUrl).not.toHaveBeenCalled();
  });
});
