import { expect, test as base } from '@playwright/test';

import { applyAllureLabels } from '../helpers/allure-labels';
import { launchObsidian, type ObsidianSession } from '../helpers/obsidian';

export const test = base.extend<{ obsidian: ObsidianSession; _allureLabels: void }>({
  // Auto-fixture: tag every test with its Allure epic from its @area: tag.
  _allureLabels: [
    async ({}, use, testInfo) => {
      await applyAllureLabels(testInfo);
      await use();
    },
    { auto: true },
  ],
  obsidian: async ({ page }, use, testInfo) => {
    const obsidian = await launchObsidian(page);
    try {
      await use(obsidian);
    } finally {
      try {
        const logs = obsidian.getHostLogs();
        if (logs.length > 0) {
          await testInfo.attach('obsidian-host-log', { body: logs, contentType: 'text/plain' });
        }
        const screenshotPath = testInfo.outputPath('final-screenshot.png');
        await page.screenshot({ path: screenshotPath });
        await testInfo.attach('final-screenshot', {
          path: screenshotPath,
          contentType: 'image/png',
        });
      } catch {
        // Attachment failures are non-fatal in teardown.
      }
      await obsidian.cleanup();
    }
  },
});

export { expect };
