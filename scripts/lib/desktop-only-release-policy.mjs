const RC_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-rc\.(?:[1-9]\d*)$/;
const FINAL_TAG = "v1.1.0";
export const DESKTOP_ONLY_TAG_ANNOTATION = "NeonDiff-Release-Class: desktop-only";

export function hasDesktopOnlyTagAnnotation(tag, annotation) {
  return (RC_TAG.test(tag) || tag === FINAL_TAG) && typeof annotation === "string" && annotation.split("\n").filter((line) => line === DESKTOP_ONLY_TAG_ANNOTATION).length === 1;
}
export function classifyDesktopOnlyRelease(tag, annotation, prerelease) {
  if (!hasDesktopOnlyTagAnnotation(tag, annotation) || RC_TAG.test(tag) !== (prerelease === true) || tag === FINAL_TAG !== (prerelease === false)) throw new Error("release is not covered by the Desktop-only npm policy");
  return Object.freeze({ shouldPublish: false, npmTag: tag === FINAL_TAG ? "latest" : "beta", releaseKind: "desktop-only" });
}
