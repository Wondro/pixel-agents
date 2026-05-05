/**
 * E2E: Clicking "+ Agent" in the Pixel Agents webview spawns a mock Codex terminal.
 *
 * Assertions:
 *   1. The mock `codex` binary was invoked (invocations.log exists and is non-empty).
 *   2. The expected JSONL session file was created in the isolated HOME.
 *   3. A VS Code terminal named "Codex #1" appears in the workbench.
 *
 * NOTE FOR NEW TESTS: As more specs are added, refactor session setup into a
 * Playwright fixture using test.extend<{ session: VSCodeSession }>() so that
 * launch/cleanup is automatic and tests stay focused on assertions. See:
 * https://playwright.dev/docs/test-fixtures
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

import { launchVSCode, waitForWorkbench } from '../helpers/launch';
import { clickAddAgent, getPixelAgentsFrame, openPixelAgentsPanel } from '../helpers/webview';

test('clicking + Agent spawns mock codex and creates a JSONL session file', async ({}, testInfo) => {
  const session = await launchVSCode(testInfo.title);
  const { window, tmpHome, mockLogFile } = session;
  const runVideo = window.video();

  test.setTimeout(120_000);

  try {
    // 1. Wait for VS Code workbench to be ready
    await waitForWorkbench(window);

    // 2. Open the Pixel Agents panel
    await openPixelAgentsPanel(window);

    // 3. Find the webview frame and click + Agent
    const frame = await getPixelAgentsFrame(window);
    await clickAddAgent(frame);

    // 4. Assert: mock codex was invoked
    //    The mock script writes to $HOME/.codex-mock/invocations.log
    await expect
      .poll(
        () => {
          try {
            const content = fs.readFileSync(mockLogFile, 'utf8');
            return content.trim().length > 0;
          } catch {
            return false;
          }
        },
        {
          message: `Expected invocations.log at ${mockLogFile} to be non-empty`,
          timeout: 20_000,
          intervals: [500, 1000],
        },
      )
      .toBe(true);

    const invocationLog = fs.readFileSync(mockLogFile, 'utf8');
    expect(invocationLog).toContain('codex');
    await testInfo.attach('mock-codex-invocations', {
      body: invocationLog,
      contentType: 'text/plain',
    });

    // 5. Assert: JSONL session file was created.
    //    Scan all subdirectories under .codex/sessions/ rather than hard-coding a
    //    specific hash. On Windows, os.tmpdir() may return an 8.3 short path while
    //    the VS Code terminal sees the long path, making the hashes differ even after
    //    normalisation attempts.
    const projectsDir = path.join(tmpHome, '.codex', 'sessions');

    const findJsonlFiles = (): string[] => {
      const walk = (dir: string): string[] =>
        fs.readdirSync(dir).flatMap((entry) => {
          const fullPath = path.join(dir, entry);
          try {
            if (fs.statSync(fullPath).isDirectory()) {
              return walk(fullPath);
            }
            return fullPath.endsWith('.jsonl') ? [fullPath] : [];
          } catch {
            return [];
          }
        });

      try {
        if (!fs.existsSync(projectsDir)) return [];
        return walk(projectsDir);
      } catch {
        return [];
      }
    };

    await expect
      .poll(findJsonlFiles, {
        message: `Expected at least one .jsonl file under ${projectsDir}`,
        timeout: 20_000,
        intervals: [500, 1000],
      })
      .not.toHaveLength(0);

    await testInfo.attach('jsonl-files', {
      body: findJsonlFiles().join('\n'),
      contentType: 'text/plain',
    });

    // 6. Assert: terminal "Codex #1" is visible in VS Code UI
    //    VS Code renders the terminal name as visible text in the tab bar.
    const terminalTab = window.getByText(/Codex #\d+/);
    await expect(terminalTab.first()).toBeVisible({ timeout: 15_000 });
  } finally {
    // Save a screenshot of the final state regardless of outcome
    const screenshotPath = path.join(
      __dirname,
      '../../test-results/e2e',
      `agent-spawn-final-${Date.now()}.png`,
    );
    try {
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await window.screenshot({ path: screenshotPath });
      await testInfo.attach('final-screenshot', {
        path: screenshotPath,
        contentType: 'image/png',
      });
    } catch {
      // screenshot failure is non-fatal
    }

    await session.cleanup();

    if (runVideo) {
      try {
        const videoPath = testInfo.outputPath('run-video.webm');
        await runVideo.saveAs(videoPath);
        await testInfo.attach('run-video', {
          path: videoPath,
          contentType: 'video/webm',
        });
      } catch {
        // video attachment failure is non-fatal
      }
    }
  }
});
