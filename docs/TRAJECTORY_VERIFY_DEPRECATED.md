# `atlasent_trajectory_verify` is not a supported MCP tool

`atlasent_trajectory_verify` is being removed from the public MCP tool surface.

The runtime does not implement `/v1/trajectory-verify`. The existing MCP registration therefore cannot complete a real authorization check and must not be presented to agents as a usable capability.

For execution-boundary authorization, use the shipped AtlaSent flow:

1. `atlasent_evaluate` to obtain the runtime Decision and Permit.
2. `atlasent_verify_permit` immediately before the protected native side effect.
3. Proceed only when Permit Verification succeeds for the exact action, actor, target, environment, and bound payload.

Do not replace this with another client-side trajectory evaluator. The AtlaSent runtime remains the sole protected-action decision authority.

Tracking: AtlaSent-Systems-Inc/atlasent-api#2932.
