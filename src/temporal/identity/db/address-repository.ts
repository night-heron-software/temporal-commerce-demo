import { executeCql, createLogger } from '../../../lib';
import type { Identity } from '../../contracts';
import { types } from 'cassandra-driver';

const logger = createLogger('identity:address-repository');

export class AddressRepository {
  async getByUserId(userId: string): Promise<Identity.SavedAddress[]> {
    logger.info({ userId }, 'AddressRepository.getByUserId');

    const rows = await executeCql<{
      address_id: types.Uuid;
      label: string;
      first_name: string;
      last_name: string;
      address1: string;
      address2: string | null;
      city: string;
      state: string;
      postal_code: string;
      country: string;
      phone: string | null;
      email: string;
      is_default: boolean;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT address_id, label, first_name, last_name, address1, address2,
              city, state, postal_code, country, phone, email,
              is_default, created_at, updated_at
       FROM shopper_shipping_addresses
       WHERE user_id = ?`,
      [userId]
    );

    return rows.map((row) => ({
      addressId: row.address_id.toString(),
      label: row.label,
      firstName: row.first_name,
      lastName: row.last_name,
      address1: row.address1,
      address2: row.address2 || undefined,
      city: row.city,
      state: row.state,
      postalCode: row.postal_code,
      country: row.country,
      phone: row.phone || undefined,
      email: row.email,
      isDefault: row.is_default,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async save(userId: string, address: Identity.SavedAddress): Promise<void> {
    logger.info({ userId, addressId: address.addressId }, 'AddressRepository.save');
    const now = new Date();

    // If setting as default, clear existing defaults first
    if (address.isDefault) {
      await this.clearDefaults(userId);
    }

    await executeCql(
      `INSERT INTO shopper_shipping_addresses
       (user_id, address_id, label, first_name, last_name,
        address1, address2, city, state, postal_code, country,
        phone, email, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        address.addressId,
        address.label,
        address.firstName,
        address.lastName,
        address.address1,
        address.address2 || null,
        address.city,
        address.state,
        address.postalCode,
        address.country,
        address.phone || null,
        address.email,
        address.isDefault,
        address.createdAt || now,
        now
      ]
    );
  }

  async delete(userId: string, addressId: string): Promise<void> {
    logger.info({ userId, addressId }, 'AddressRepository.delete');

    await executeCql(
      `DELETE FROM shopper_shipping_addresses WHERE user_id = ? AND address_id = ?`,
      [userId, addressId]
    );
  }

  async setDefault(userId: string, addressId: string): Promise<void> {
    logger.info({ userId, addressId }, 'AddressRepository.setDefault');

    // Clear existing defaults
    await this.clearDefaults(userId);

    // Set new default
    await executeCql(
      `UPDATE shopper_shipping_addresses SET is_default = true, updated_at = ?
       WHERE user_id = ? AND address_id = ?`,
      [new Date(), userId, addressId]
    );
  }

  private async clearDefaults(userId: string): Promise<void> {
    const addresses = await this.getByUserId(userId);
    const defaults = addresses.filter((a) => a.isDefault);

    await Promise.all(
      defaults.map((addr) =>
        executeCql(
          `UPDATE shopper_shipping_addresses SET is_default = false, updated_at = ?
           WHERE user_id = ? AND address_id = ?`,
          [new Date(), userId, addr.addressId]
        )
      )
    );
  }
}
