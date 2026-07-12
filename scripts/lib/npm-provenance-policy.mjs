export async function verifyNpmProvenanceBundle(input, verifyBundle) {
  const slsa = input.document?.attestations?.filter(
    (item) => item?.predicateType === "https://slsa.dev/provenance/v1"
  ) ?? [];
  if (slsa.length !== 1) throw new Error("attestations response must contain exactly one SLSA provenance statement");
  const bundle = slsa[0].bundle;
  await verifyBundle(bundle, {
    certificateIssuer: "https://token.actions.githubusercontent.com",
    certificateIdentityURI: `https://github.com/${input.expectedRepository}/${input.expectedWorkflow}@refs/tags/${input.expectedTag}`
  });

  let statement;
  try {
    statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  } catch {
    throw new Error("SLSA provenance payload must be valid base64 JSON");
  }
  if (statement.predicateType !== "https://slsa.dev/provenance/v1") throw new Error("SLSA predicate type does not match");
  const expectedSubject = `pkg:npm/${input.expectedPackage}@${input.expectedVersion}`;
  const subject = statement.subject?.find((item) => item?.name === expectedSubject);
  if (!subject) throw new Error("provenance subject does not match the npm package");
  const expectedSha512 = Buffer.from(input.expectedIntegrity.slice("sha512-".length), "base64").toString("hex");
  if (subject.digest?.sha512 !== expectedSha512) throw new Error("provenance subject digest does not match the reviewed tarball");
  const build = statement.predicate?.buildDefinition;
  const workflow = build?.externalParameters?.workflow;
  if (workflow?.repository !== `https://github.com/${input.expectedRepository}`) throw new Error("provenance repository does not match");
  if (workflow?.path !== input.expectedWorkflow) throw new Error("provenance workflow does not match");
  if (workflow?.ref !== `refs/tags/${input.expectedTag}`) throw new Error("provenance tag ref does not match");
  const dependency = build?.resolvedDependencies?.find((item) => item?.digest?.gitCommit);
  if (dependency?.digest?.gitCommit !== input.expectedCommit) throw new Error("provenance git commit does not match");
  if (dependency?.uri !== `git+https://github.com/${input.expectedRepository}@refs/tags/${input.expectedTag}`) {
    throw new Error("provenance resolved dependency does not match the release tag");
  }
  return { package: input.expectedPackage, version: input.expectedVersion, commit: input.expectedCommit, sha512: expectedSha512 };
}
