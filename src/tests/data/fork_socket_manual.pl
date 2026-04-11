use strict;
use warnings;
use Time::HiRes qw(usleep);

require './dbconfig.pl';
test('pre-fork setup');

sub compute_value {
    my ($base) = @_;
    my $value = $base;
    $value += 3;
    $value *= 2;
    return $value;
}

print "starting parent pid=$$\n";

my $pid = fork();
if (!defined $pid) {
    die "fork failed: $!\n";
}

if ($pid == 0) {
    my $child_value = compute_value(2);

    print "child attached\n";

    for my $i (1 .. 5) {
        $child_value += $i;
        my $child_hash = {
            index => $i,
            value => $child_value,
            role  => 'child'
        };
        print "child loop i=$i value=$child_hash->{value}\n";
        usleep(200_000);
    }

    my @child_list = ('alpha', 'beta', 'gamma');
    print "child done count=" . scalar(@child_list) . "\n";
    exit 0;
}

my $parent_value = compute_value(10);
print "parent attached\n";

for my $j (1 .. 5) {
    $parent_value += $j;
    my %parent_hash = (
        index => $j,
        value => $parent_value,
        role  => 'parent'
    );
    print "parent loop j=$j value=$parent_hash{value}\n";
    usleep(150_000);
}

waitpid($pid, 0);
my @parent_list = (1, 2, 3, 4);
print "parent done count=" . scalar(@parent_list) . "\n";
