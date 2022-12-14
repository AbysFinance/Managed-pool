import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Contract } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';

import { actionId } from '@balancer-labs/v2-helpers/src/models/misc/actions';
import { advanceTime } from '@balancer-labs/v2-helpers/src/time';
import { deploy, deployedAt } from '@balancer-labs/v2-helpers/src/contract';
import { ZERO_ADDRESS } from '@balancer-labs/v2-helpers/src/constants';

describe('TimelockAuthorizerMigrator', () => {
  let user1: SignerWithAddress, user2: SignerWithAddress, user3: SignerWithAddress, root: SignerWithAddress;
  let vault: Contract, oldAuthorizer: Contract, newAuthorizer: Contract, migrator: Contract;

  before('set up signers', async () => {
    [, user1, user2, user3, root] = await ethers.getSigners();
  });

  let rolesData: Array<{ role: string; target: string }>;
  const ROLE_1 = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const ROLE_2 = '0x0000000000000000000000000000000000000000000000000000000000000002';
  const ROLE_3 = '0x0000000000000000000000000000000000000000000000000000000000000003';

  sharedBeforeEach('set up vault', async () => {
    oldAuthorizer = await deploy('MockBasicAuthorizer');
    vault = await deploy('Vault', { args: [oldAuthorizer.address, ZERO_ADDRESS, 0, 0] });
  });

  sharedBeforeEach('set up permissions', async () => {
    const target = await deploy('MockBasicAuthorizer'); // any contract
    await oldAuthorizer.grantRolesToMany([ROLE_1, ROLE_2, ROLE_3], [user1.address, user2.address, user3.address]);
    rolesData = [
      { role: ROLE_1, target: target.address },
      { role: ROLE_2, target: target.address },
      { role: ROLE_3, target: target.address },
    ];
  });

  sharedBeforeEach('set up migrator', async () => {
    const args = [vault.address, root.address, oldAuthorizer.address, rolesData];
    migrator = await deploy('TimelockAuthorizerMigrator', { args });
    newAuthorizer = await deployedAt('TimelockAuthorizer', await migrator.newAuthorizer());
    const setAuthorizerActionId = await actionId(vault, 'setAuthorizer');
    await oldAuthorizer.grantRolesToMany([setAuthorizerActionId], [migrator.address]);

    const CHANGE_ROOT_DELAY = await newAuthorizer.getRootTransferDelay();
    await advanceTime(CHANGE_ROOT_DELAY);
  });

  const itMigratesPermissionsProperly = (migrate: () => Promise<unknown>) => {
    it('runs the migration properly', async () => {
      expect(await migrator.migratedRoles()).to.be.equal(0);

      await migrate();

      expect(await migrator.migratedRoles()).to.be.equal(rolesData.length);
      expect(await migrator.isComplete()).to.be.true;
    });

    it('migrates all roles properly', async () => {
      await migrate();

      for (const roleData of rolesData) {
        const membersCount = await oldAuthorizer.getRoleMemberCount(roleData.role);
        for (let i = 0; i < membersCount; i++) {
          const member = await oldAuthorizer.getRoleMember(roleData.role, i);
          expect(await newAuthorizer.hasPermission(roleData.role, member, roleData.target)).to.be.true;
        }
      }
    });

    it('does not set the new authorizer immediately', async () => {
      await migrate();

      expect(await newAuthorizer.isRoot(migrator.address)).to.be.true;
      expect(await vault.getAuthorizer()).to.be.equal(oldAuthorizer.address);
    });

    context('finalization', () => {
      sharedBeforeEach('migrate all roles', async () => {
        await migrate();
      });

      context('when new root has not claimed ownership over TimelockAuthorizer', () => {
        it('reverts', async () => {
          await expect(migrator.finalizeMigration()).to.be.revertedWith('ROOT_NOT_CLAIMED_YET');
        });
      });

      context('when new root has claimed ownership over TimelockAuthorizer', () => {
        sharedBeforeEach('claim root', async () => {
          await newAuthorizer.connect(root).claimRoot();
        });

        it('sets the new Authorizer on the Vault', async () => {
          await migrator.finalizeMigration();

          expect(await vault.getAuthorizer()).to.be.equal(newAuthorizer.address);
        });
      });
    });
  };

  context('with a partial migration', () => {
    itMigratesPermissionsProperly(() => migrator.migrate(0));
  });

  context('with a full migration', () => {
    itMigratesPermissionsProperly(() => Promise.all(rolesData.map(async () => await migrator.migrate(1))));
  });
});
