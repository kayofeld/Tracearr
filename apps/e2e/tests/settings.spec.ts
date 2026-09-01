import { test, expect } from '@playwright/test';
import path from 'path';

test.use({ storageState: path.resolve(import.meta.dirname, '../.auth/user.json') });

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
  });

  test('settings page loads with nav tabs', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();

    // Settings sub-navigation tabs
    await expect(page.getByRole('link', { name: 'General' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Servers' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Access Control' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Mobile' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Import' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Jobs' })).toBeVisible();
  });

  test('general settings loads by default', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Application' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'External Access' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'API Key' })).toBeVisible();
  });

  test('can navigate to servers settings', async ({ page }) => {
    await page.getByRole('link', { name: 'Servers' }).click();
    await expect(page.getByRole('heading', { name: 'Connected Servers' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Linked Plex Accounts' })).toBeVisible();
  });

  test('can navigate to notifications settings', async ({ page }) => {
    await page.getByRole('link', { name: 'Notifications' }).click();
    await expect(page.getByRole('heading', { name: 'Notification destinations' })).toBeVisible();
  });

  test('can navigate to access control settings', async ({ page }) => {
    await page.getByRole('link', { name: 'Access Control' }).click();
    await expect(page.getByRole('heading', { name: 'Access Control' })).toBeVisible();
  });

  test('can navigate to mobile settings', async ({ page }) => {
    await page.getByRole('link', { name: 'Mobile' }).click();
    await expect(page.getByRole('heading', { name: 'Get the App' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pair Your Device' })).toBeVisible();
  });

  test('can navigate to import settings', async ({ page }) => {
    await page.getByRole('link', { name: 'Import' }).click();
    await expect(page.getByRole('heading', { name: 'Import History' })).toBeVisible();
  });

  test('can navigate to jobs settings', async ({ page }) => {
    await page.getByRole('link', { name: 'Jobs' }).click();
    await expect(page.getByRole('heading', { name: 'Maintenance Jobs' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Job History' })).toBeVisible();
  });
});
