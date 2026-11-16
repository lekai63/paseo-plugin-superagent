/**
 * Settings validation messages. The zod schema in shared/settings.ts stores these keys as issue
 * messages; the settings screen translates them with `settingsIssueText`.
 */
export const validation = {
  profileNameFormat: "Start with a lowercase letter; use only lowercase letters, digits, - and _; at most 24 characters",
  thinkingOption: "Thinking level ID: start with a lowercase letter; use only lowercase letters, digits, ., _ and -; leave empty for the provider default",
  reservedProfileName: "\"{{name}}\" is reserved for the default Worker",
  providerRequired: "Provider is required",
  descriptionRequired: "Describe what it is for; the Router uses this to choose a profile",
  duplicateProfileName: "Profile name \"{{name}}\" is used more than once",
  tooLong: "Too long",
} as const;
