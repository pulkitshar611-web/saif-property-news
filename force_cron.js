require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function forceExpireLeases() {
    console.log('[Fix] Checking for active leases with past end dates...');
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    try {
        const expiredLeases = await prisma.lease.findMany({
            where: {
                status: 'Active',
                endDate: {
                    lt: today
                }
            },
            include: {
                unit: true
            }
        });

        if (expiredLeases.length === 0) {
            console.log('[Fix] No active leases found with past end dates.');
            return;
        }

        console.log(`[Fix] Found ${expiredLeases.length} leases to expire.`);

        for (const lease of expiredLeases) {
            console.log(`[Fix] Updating Lease ID ${lease.id} -> Expired`);
            await prisma.lease.update({
                where: { id: lease.id },
                data: { status: 'Expired' }
            });

            // Check if there are other active leases for this unit
            const otherActiveLeases = await prisma.lease.findMany({
                where: {
                    unitId: lease.unitId,
                    status: { in: ['Active', 'DRAFT'] },
                    NOT: { id: lease.id }
                }
            });

            if (lease.unit.status !== 'Under Maintenance' && otherActiveLeases.length === 0) {
                console.log(`[Fix] Resetting Unit ID ${lease.unitId} -> Vacant`);
                await prisma.unit.update({
                    where: { id: lease.unitId },
                    data: { status: 'Vacant', rentalMode: 'FULL_UNIT' } // Reset rentalMode too
                });

                // Reset all bedrooms for this unit
                await prisma.bedroom.updateMany({
                    where: { unitId: lease.unitId },
                    data: { status: 'Vacant' }
                });
            }
        }

        console.log('[Fix] Done executing force expiration script.');
    } catch (err) {
        console.error('[Fix] Error:', err);
    } finally {
        await prisma.$disconnect();
    }
}

forceExpireLeases();
