import { executeCql, createLogger } from '../../../lib';
import type { Identity } from '../../contracts';
import { types } from 'cassandra-driver';

const logger = createLogger('identity:address-repository');

export class AddressRepository {
  async getByUserId(storeId: string, userId: string): Promise<Identity.SavedAddress[]> {
    logger.info({ storeId, userId }, 'AddressRepository.getByUserId');

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
       WHERE store_id = ? AND user_id = ?`,
      [storeId, userId]
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

  async save(storeId: string, userId: string, address: Identity.SavedAddress): Promise<void> {
    logger.info({ storeId, userId, addressId: address.addressId }, 'AddressRepository.save');
    const now = new Date();

    // If setting as default, clear existing defaults first
    if (address.isDefault) {
      await this.clearDefaults(storeId, userId);
    }

    await executeCql(
      `INSERT INTO shopper_shipping_addresses
       (store_id, user_id, address_id, label, first_name, last_name,
        address1, address2, city, state, postal_code, country,
        phone, email, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        storeId,
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

  async delete(storeId: string, userId: string, addressId: string): Promise<void> {
    logger.info({ storeId, userId, addressId }, 'AddressRepository.delete');

    await executeCql(
      `DELETE FROM shopper_shipping_addresses WHERE store_id = ? AND user_id = ? AND address_id = ?`,
      [storeId, userId, addressId]
    );
  }

  async setDefault(storeId: string, userId: string, addressId: string): Promise<void> {
    logger.info({ storeId, userId, addressId }, 'AddressRepository.setDefault');

    // Clear existing defaults
    await this.clearDefaults(storeId, userId);

    // Set new default
    await executeCql(
      `UPDATE shopper_shipping_addresses SET is_default = true, updated_at = ?
       WHERE store_id = ? AND user_id = ? AND address_id = ?`,
      [new Date(), storeId, userId, addressId]
    );
  }

  private async clearDefaults(storeId: string, userId: string): Promise<void> {
    const addresses = await this.getByUserId(storeId, userId);
    const defaults = addresses.filter((a) => a.isDefault);

    await Promise.all(
      defaults.map((addr) =>
        executeCql(
          `UPDATE shopper_shipping_addresses SET is_default = false, updated_at = ?
           WHERE store_id = ? AND user_id = ? AND address_id = ?`,
          [new Date(), storeId, userId, addr.addressId]
        )
      )
    );
  }
}
