import { describe, expect, it } from "vitest";
import { name } from "../src/index.js";

describe("mcpsieve", () => {
  it("exports its name", () => {
    expect(name).toBe("mcpsieve");
  });
});
