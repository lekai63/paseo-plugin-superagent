import type { Translation } from "../../i18n";
import type { validation as en } from "../en/validation";

export const validation: Translation<typeof en> = {
  profileNameFormat: "小写字母开头,只含小写字母、数字、- 和 _,最长 24 个字符",
  thinkingOption: "thinking 档位 id:小写字母开头,只含小写字母/数字/./_/-,留空用 provider 默认",
  reservedProfileName: "\"{{name}}\" 留给默认 Worker",
  providerRequired: "需要填写 provider",
  descriptionRequired: "需要写明用途,Router 靠它选择档位",
  duplicateProfileName: "档位名 \"{{name}}\" 重复",
  tooLong: "内容过长",
};
