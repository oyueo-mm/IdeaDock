export function assertPreviewTarget(environment) {
  if (
    environment.VERCEL_ENV === "production" ||
    (environment.VERCEL === "1" && environment.VERCEL_ENV !== "preview")
  ) {
    throw new Error(
      "Only Vercel Preview is authorized for this branch. Refusing a production or unknown deployment target.",
    );
  }
}

assertPreviewTarget(process.env);
