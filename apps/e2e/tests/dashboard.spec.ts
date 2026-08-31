import { test, expect } from '@playwright/test';
import path from 'path';

test.use({ storageState: path.resolve(import.meta.dirname, '../.auth/user.json') });

test.describe('Dashboard', () => {
  test('loads and shows stat cards', async ({ page }) => {
    await page.goto('/');

    // "Today" section header
    // await expect(page.getByText('Today')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

    // Stat cards
    await expect(page.getByText('Alerts')).toBeVisible();
    await expect(page.getByText('Plays')).toBeVisible();
    await expect(page.getByText('Watch Time')).toBeVisible();
    await expect(page.getByText('Active Users')).toBeVisible();

    // "Now Playing" section header
    await expect(page.getByText('Now Playing')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Now Playing' })).toBeVisible();
    await expect(page.getByText('No active streams')).toBeVisible();
  });

  test('sidebar navigation is visible', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Map' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'History' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Activity' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'By User' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Bandwidth' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Users', exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Automations' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Violations' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  });
});
