const prisma = require('../../config/prisma');

exports.getRevenueStats = async (req, res) => {
    try {
        const { ownerId } = req.query;
        console.log('Revenue Stats - Received ownerId:', ownerId);
        const parsedOwnerId = ownerId && ownerId !== 'null' && ownerId !== '' ? parseInt(ownerId) : null;

        let propertyIds = [];
        if (parsedOwnerId) {
            const ownerProperties = await prisma.property.findMany({
                where: {
                    owners: {
                        some: { id: parsedOwnerId }
                    }
                },
                select: { id: true }
            });
            propertyIds = ownerProperties.map(p => p.id);
        }

        const unitFilter = parsedOwnerId ? { propertyId: { in: propertyIds } } : {};

        // 2. Projected Revenue (Requirement 7): Sum of monthlyRent across all Active leases
        const leaseAgg = await prisma.lease.aggregate({
            where: {
                status: 'Active',
                unit: unitFilter
            },
            _sum: { monthlyRent: true }
        });
        const projectedRevenue = parseFloat(leaseAgg._sum.monthlyRent) || 0;

        // Fetch all paid invoices for Actual Revenue and breakdowns
        const invoices = await prisma.invoice.findMany({
            where: {
                paidAmount: { gt: 0 },
                unit: unitFilter
            },
            include: { unit: { include: { property: true } } }
        });

        let actualRevenue = 0;
        let actualRent = 0;
        let actualDeposit = 0;
        let actualServiceFees = 0;
        const propertyMap = {};
        const monthlyMap = {};

        invoices.forEach(inv => {
            const amount = parseFloat(inv.paidAmount) || 0;
            actualRevenue += amount;

            let type = 'Rent';
            if (inv.category === 'SERVICE') {
                if (inv.description && inv.description.includes('Secondary Deposit') || inv.description?.includes('Security Deposit')) {
                    type = 'Deposit';
                    actualDeposit += amount;
                } else {
                    type = 'ServiceFees';
                    actualServiceFees += amount;
                }
            } else {
                actualRent += amount;
            }

            // Breakdown by Property
            const propName = inv.unit?.property?.name || 'Other Building';
            if (!propertyMap[propName]) propertyMap[propName] = { amount: 0, rent: 0, deposit: 0, serviceFees: 0 };
            propertyMap[propName].amount += amount;
            if (type === 'Rent') propertyMap[propName].rent += amount;
            else if (type === 'Deposit') propertyMap[propName].deposit += amount;
            else if (type === 'ServiceFees') propertyMap[propName].serviceFees += amount;

            // Monthly Breakdown
            if (!monthlyMap[inv.month]) monthlyMap[inv.month] = { amount: 0, rent: 0, deposit: 0, serviceFees: 0 };
            monthlyMap[inv.month].amount += amount;
            if (type === 'Rent') monthlyMap[inv.month].rent += amount;
            else if (type === 'Deposit') monthlyMap[inv.month].deposit += amount;
            else if (type === 'ServiceFees') monthlyMap[inv.month].serviceFees += amount;
        });

        const revenueByProperty = Object.keys(propertyMap).map(p => ({
            name: p,
            amount: propertyMap[p].amount,
            rent: propertyMap[p].rent,
            deposit: propertyMap[p].deposit,
            serviceFees: propertyMap[p].serviceFees
        }));

        const monthlyRevenue = Object.keys(monthlyMap).map(m => ({
            month: m,
            amount: monthlyMap[m].amount,
            rent: monthlyMap[m].rent,
            deposit: monthlyMap[m].deposit,
            serviceFees: monthlyMap[m].serviceFees
        }));

        res.json({
            actualRevenue,
            actualRent,
            actualDeposit,
            actualServiceFees,
            projectedRevenue,
            totalRevenue: actualRevenue, // Backward compatibility
            monthlyRevenue,
            revenueByProperty
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
};

exports.getVacancyStats = async (req, res) => {
    try {
        const { ownerId } = req.query;
        console.log('Vacancy Stats - Received ownerId:', ownerId);
        const parsedOwnerId = ownerId && ownerId !== 'null' && ownerId !== '' ? parseInt(ownerId) : null;

        const units = await prisma.unit.findMany({
            where: parsedOwnerId ? {
                property: {
                    owners: {
                        some: { id: parsedOwnerId }
                    }
                }
            } : {},
            include: { property: true }
        });

        const total = units.length;
        const vacant = units.filter(u => u.status === 'Vacant').length;
        const occupied = total - vacant;

        // By Building
        const buildingStats = {};
        units.forEach(u => {
            const propName = u.property?.name || 'Other';
            if (!buildingStats[propName]) buildingStats[propName] = { total: 0, vacant: 0 };
            buildingStats[propName].total++;
            if (u.status === 'Vacant') buildingStats[propName].vacant++;
        });

        const vacancyByBuilding = Object.keys(buildingStats).map(p => ({
            name: p,
            vacant: buildingStats[p].vacant,
            total: buildingStats[p].total
        }));

        res.json({
            total,
            vacant,
            occupied,
            vacancyByBuilding
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Server error' });
    }
};
