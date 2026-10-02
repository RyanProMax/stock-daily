import { SNOWFLAKE_PRESS_RELEASE_VERSION, snowflakePressReleaseIdentity, snowflakePressReleaseRecord } from "./snowflake-press-release.mjs";
import { GEVERNOVA_PRESS_RELEASE_VERSION, gevernovaPressReleaseIdentity, gevernovaPressReleaseRecord } from "./gevernova-press-release.mjs";

export function nativeIssuerReleaseIdentity(source) {
  const snowflake = snowflakePressReleaseIdentity(source);
  if (snowflake) return { ...snowflake, issuerDomain: "snowflake.com", version: SNOWFLAKE_PRESS_RELEASE_VERSION };
  const gevernova = gevernovaPressReleaseIdentity(source);
  return gevernova ? { ...gevernova, issuerDomain: "gevernova.com", version: GEVERNOVA_PRESS_RELEASE_VERSION } : null;
}

export function nativeIssuerReleaseRecord(html, source) {
  const identity = nativeIssuerReleaseIdentity(source);
  const record = identity?.issuerDomain === "snowflake.com" ? snowflakePressReleaseRecord(html, source) : identity?.issuerDomain === "gevernova.com" ? gevernovaPressReleaseRecord(html, source) : null;
  return record ? { ...record, issuerDomain: identity.issuerDomain } : null;
}
